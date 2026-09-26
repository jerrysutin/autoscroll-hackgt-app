/**
 * Local microphone reactions. Two detectors produce discrete events:
 *  - Sounds: YAMNet hears laughter (positive) or groans/sighs/crying (negative).
 *  - Words: each spoken phrase is transcribed on-device (Whisper) and its text
 *    sentiment is scored (RoBERTa). See speech-core.js for the rules.
 * The newest non-neutral event is held for HOLD_MS, then output returns to neutral.
 * onSignal receives ONLY "positive", "negative", or "neutral", and only on change.
 * Call start() from a user gesture in a persistent page, and stop() on pagehide.
 */
const SAMPLE_RATE = 16000;
// 96 spectrogram frames at 10 ms spacing plus the 25 ms FFT window.
// Exactly one complete YAMNet patch, without a second mostly padded patch.
const WINDOW_SECONDS = 0.975;
const HOP_SECONDS = 0.24;
const SCORE_SMOOTHING = 0.5;
// Only skip near-silence; quiet microphone reactions still need model inference.
const MIN_RMS = 0.001;
const MODEL_TARGET_RMS = 0.05; // about -26 dBFS for audible input
const MAX_MODEL_GAIN = 32; // never amplify by more than about 30 dB
const SCORE_THRESHOLD = 0.01;
const SCORE_MARGIN = 0;
// How long one reaction event drives the output.
const HOLD_MS = 3000;
// A sound reaction must appear in consecutive YAMNet windows (240 ms apart).
const CONFIRM_WINDOWS = 2;
// Phrase results older than this (e.g. after a long busy queue) are dropped.
const MAX_PHRASE_AGE_MS = 8000;
// Official YAMNet AudioSet class indices; baby sounds and sighs are excluded.
const POSITIVE_CLASSES = [13, 15, 16, 17, 18]; // laughter, giggle, snicker, belly laugh, chuckle
// Speech, conversation, narration, shouting, yelling, and whispering.
const SPEECH_CLASSES = [0, 1, 2, 3, 6, 7, 9, 10, 12];
// Crying, whimper, wail/moan, sigh, groan, grunt: the nonverbal "ugh" family.
const NEGATIVE_CLASSES = [19, 21, 22, 23, 33, 34];
// Phrases are transcribed when YAMNet hears a voice, including a sighed "ugh".
const VOCAL_CLASSES = [...SPEECH_CLASSES, ...POSITIVE_CLASSES, ...NEGATIVE_CLASSES];
// A reaction sound mixed with speech rarely ranks first. Accept it when it is
// substantial on its own and comparable to the strongest sound.
const MIXED_REACTION_SCORE = 0.15;
const MIXED_REACTION_RATIO = 0.4;
const SENSITIVITY = {
    standard: { threshold: SCORE_THRESHOLD, margin: SCORE_MARGIN },
    // Keep the existing API names compatible; both use the same minimum score.
    high: { threshold: SCORE_THRESHOLD, margin: SCORE_MARGIN }
};
let runtimePromise;

function describeScores(scores, { threshold = SCORE_THRESHOLD, margin = SCORE_MARGIN } = {}) {
    if (scores.length !== 521 || scores.some(score => !Number.isFinite(score))) {
        throw new Error('YAMNet returned invalid sound scores.');
    }
    const positive = Math.max(...POSITIVE_CLASSES.map(index => scores[index]));
    const negative = Math.max(...NEGATIVE_CLASSES.map(index => scores[index]));
    return { ...describeReaction(positive, negative, { threshold, margin }),
        speechScore: Math.max(...SPEECH_CLASSES.map(index => scores[index])),
        topIndex: scores.indexOf(Math.max(...scores)), topScore: Math.max(...scores) };
}

function describeReaction(positive, negative, { threshold = SCORE_THRESHOLD, margin = SCORE_MARGIN } = {}) {
    let signal = 'neutral';
    let reason = positive < threshold && negative < threshold ? 'below-threshold' : 'ambiguous';
    if (positive > negative && positive >= threshold && positive - negative >= margin) { signal = 'positive'; reason = 'reaction'; }
    if (negative > positive && negative >= threshold && negative - positive >= margin) { signal = 'negative'; reason = 'reaction'; }
    return { signal, reason, positive, negative, threshold, margin };
}

function labelFromScores(scores, options) {
    return describeScores(scores, options).signal;
}

async function loadRuntime() {
    if (globalThis.tf) return globalThis.tf;
    if (!runtimePromise) {
        runtimePromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL('./audio-assets/tf.min.js', import.meta.url).href;
            script.onload = () => globalThis.tf ? resolve(globalThis.tf) : reject(new Error('TensorFlow.js did not initialize.'));
            script.onerror = () => {
                script.remove();
                reject(new Error('Audio model files are missing. Run node scripts/setup-audio.mjs and rebuild the extension.'));
            };
            document.head.append(script);
        }).catch(error => { runtimePromise = null; throw error; });
    }
    return runtimePromise;
}

// YAMNet is sensitive to recording level. Bring audible quiet input closer to
// training-scale audio without amplifying near-silence or introducing clipping.
function prepareWaveform(samples) {
    let energy = 0;
    let peak = 0;
    for (const value of samples) {
        if (!Number.isFinite(value)) throw new Error('Invalid microphone samples.');
        energy += value * value;
        peak = Math.max(peak, Math.abs(value));
    }
    const rms = samples.length ? Math.sqrt(energy / samples.length) : 0;
    const gain = rms >= MIN_RMS
        ? Math.max(1, Math.min(MAX_MODEL_GAIN, MODEL_TARGET_RMS / rms, 0.95 / peak))
        : 1;
    return { samples: gain === 1 ? samples : samples.map(value => value * gain),
        inputGain: gain, modelRms: rms * gain };
}

async function loadYamnet() {
    const tf = await loadRuntime();
    await tf.ready();
    const classResponse = await fetch(new URL('./audio-assets/yamnet/yamnet_class_map.csv', import.meta.url));
    if (!classResponse.ok) throw new Error('Could not load the audio model class names.');
    const names = (await classResponse.text()).trim().split(/\r?\n/).slice(1).map(line => {
        const label = line.slice(line.indexOf(',', line.indexOf(',') + 1) + 1);
        return label.replace(/^"|"$/g, '').replace(/""/g, '"');
    });
    let diagnostics = null;
    let positive = 0;
    let negative = 0;
    let lastAnalysis = 0;
    function reset() {
        positive = negative = lastAnalysis = 0;
        diagnostics = null;
    }
    const model = await tf.loadGraphModel(new URL('./audio-assets/yamnet/model.json', import.meta.url).href);
    return {
        async classify(samples, options) {
            const prepared = prepareWaveform(samples);
            const input = tf.tensor1d(prepared.samples);
            let outputs;
            let pooled;
            try {
                outputs = await model.executeAsync(input);
                const tensors = Array.isArray(outputs) ? outputs : Object.values(outputs);
                const scores = tensors.find(tensor => tensor.shape.length === 2 && tensor.shape[1] === 521);
                if (!scores) throw new Error('Unexpected YAMNet output: sound scores are missing.');
                // The capture path supplies one full patch; support longer adapter input too.
                pooled = scores.max(0);
                const raw = describeScores(await pooled.data(), options);
                const now = Date.now();
                if (lastAnalysis && now - lastAnalysis > 1500) reset();
                lastAnalysis = now;
                // Smooth reaction groups so changing laughter subtypes do not dilute evidence.
                positive += SCORE_SMOOTHING * (raw.positive - positive);
                negative += SCORE_SMOOTHING * (raw.negative - negative);
                diagnostics = { ...raw, ...describeReaction(positive, negative, options),
                    rawPositive: raw.positive, rawNegative: raw.negative,
                    inputGain: prepared.inputGain, modelRms: prepared.modelRms };
                diagnostics.topSound = names[diagnostics.topIndex] || `Class ${diagnostics.topIndex}`;
                return diagnostics.signal;
            } finally {
                pooled?.dispose();
                tf.dispose(outputs);
                input.dispose();
            }
        },
        reset,
        getDiagnostics: () => diagnostics,
        dispose: () => model.dispose()
    };
}

async function resample(samples, sourceRate) {
    if (sourceRate === SAMPLE_RATE) return samples;
    // OfflineAudioContext performs band-limited conversion at the actual device rate.
    const context = new OfflineAudioContext(1, Math.round(samples.length * SAMPLE_RATE / sourceRate), SAMPLE_RATE);
    const buffer = context.createBuffer(1, samples.length, sourceRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    return (await context.startRendering()).getChannelData(0);
}

function microphoneError(error) {
    const messages = {
        NotAllowedError: 'Microphone access was denied or blocked. Allow it in Safari and macOS microphone settings, then try again. If Safari never prompts, try the localhost test page described in README.md.',
        NotFoundError: 'No microphone was found. Connect one and try again.',
        OverconstrainedError: 'The selected microphone is unavailable. Refresh the microphone list and choose another input.',
        NotReadableError: 'The microphone could not be opened. Check other apps using it and try again.',
        SecurityError: 'Microphone capture is blocked in this browser context.'
    };
    return new Error(messages[error.name] || error.message || 'Audio detection failed.', { cause: error });
}

async function loadDefaultSpeech(options) {
    const { loadSpeechClassifier } = await import('./speech.js');
    return loadSpeechClassifier(options);
}

function hasSpeech(yamnet) {
    return yamnet && (VOCAL_CLASSES.includes(yamnet.topIndex) ||
        (yamnet.speechScore >= 0.2 && yamnet.speechScore >= yamnet.topScore * 0.5));
}

function clearReaction(classes, score, yamnet) {
    if (!(score >= SCORE_THRESHOLD)) return false;
    return classes.includes(yamnet.topIndex) ||
        (score >= MIXED_REACTION_SCORE && score >= (yamnet.topScore ?? Infinity) * MIXED_REACTION_RATIO);
}

function directReaction(yamnet) {
    if (!yamnet) return 'neutral';
    // Require a reaction sound to be the strongest class or a substantial share of
    // it, not a tiny incidental sigmoid score during speech or background noise.
    const positive = yamnet.rawPositive ?? yamnet.positive ?? 0;
    const negative = yamnet.rawNegative ?? yamnet.negative ?? 0;
    const isPositive = clearReaction(POSITIVE_CLASSES, positive, yamnet);
    const isNegative = clearReaction(NEGATIVE_CLASSES, negative, yamnet);
    if (isPositive && (!isNegative || positive > negative)) return 'positive';
    if (isNegative && negative > positive) return 'negative';
    // Label-only adapters have no scores or class metadata to route by.
    return yamnet.topIndex == null ? yamnet.signal : 'neutral';
}

/**
 * Example: const audio = createAudioDetector({ onSignal: signal => decision(signal) });
 * await audio.start(); // from a click handler
 * await audio.stop();
 * loadClassifier / loadSpeechClassifier are optional adapters for tests or other
 * models. Pass loadSpeechClassifier: null to use sounds only.
 */
export function createAudioDetector({ onSignal = () => {}, onError = () => {}, onStateChange = () => {}, onDiagnostics = () => {}, onInput = () => {}, onSpeech = () => {}, loadSpeechClassifier = loadDefaultSpeech, loadClassifier = loadYamnet } = {}) {
    let current = null;
    let state = 'idle';
    let signal = 'neutral';
    let sensitivity = 'standard';

    function setSensitivity(value) {
        if (!Object.hasOwn(SENSITIVITY, value)) throw new Error('Unknown audio sensitivity.');
        sensitivity = value;
        current?.classifier?.reset?.();
    }

    const setState = value => { state = value; onStateChange(value); };
    const publish = value => {
        if (value === signal) return;
        signal = value;
        onSignal(value);
    };
    const active = session => current === session;

    function release(session) {
        session.speechAbort?.abort();
        session.speechClassifier?.dispose();
        session.speechClassifier = null;
        session.stream?.getTracks().forEach(track => track.stop());
        session.source?.disconnect();
        if (session.worklet) {
            session.worklet.port.onmessage = null;
            session.worklet.port.close();
            session.worklet.disconnect();
        }
        session.context.onstatechange = null;
        if (session.context.state !== 'closed') session.context.close().catch(() => {});
        if (session.classifier && !session.busy) {
            session.classifier.dispose();
            session.classifier = null;
        }
    }

    function stop() {
        const session = current;
        current = null; // invalidates late permission/model/inference results
        if (session) release(session);
        publish('neutral');
        onDiagnostics(null);
        onInput(null);
        onSpeech(null);
        setState('idle');
        return session?.inference?.catch(() => {});
    }

    function fail(session, error) {
        if (!active(session)) return;
        stop();
        setState('error');
        onError(microphoneError(error));
    }

    // The single source of truth for output: the newest non-neutral event,
    // until it expires. Neutral results never cut a held reaction short.
    function react(session, value, source, detail = {}) {
        if (!active(session) || value === 'neutral') return;
        session.event = { signal: value, source, at: Date.now(), ...detail };
        publish(value);
    }

    function expire(session) {
        if (session.event && Date.now() - session.event.at >= HOLD_MS) {
            session.event = null;
            publish('neutral');
        }
    }

    function report(session) {
        if (!session.yamnet) return;
        onDiagnostics({ ...session.yamnet, soundSignal: session.soundSignal,
            combinedSignal: signal, source: session.event?.source || null,
            decisionReason: session.event ? `${session.event.source}-reaction` : 'no-reaction' });
    }

    function hasVoiceDuring(packet, history) {
        return history.some(item => item.endSample > packet.startSample && item.startSample < packet.endSample &&
            hasSpeech(item.diagnostics));
    }

    function tryPhrase(session) {
        const packet = session.pendingPhrase;
        if (!active(session) || !packet || !session.speechClassifier || session.speechBusy) return;
        if (Date.now() - packet.receivedAt > MAX_PHRASE_AGE_MS) {
            session.pendingPhrase = null;
            return;
        }
        if (!hasVoiceDuring(packet, session.history)) {
            // YAMNet's overlapping window can arrive after the phrase ends. Wait
            // briefly before rejecting music or noise, which Whisper would invent words for.
            if (session.audioEnd - packet.endSample > session.context.sampleRate * 1.5) {
                session.pendingPhrase = null;
                onSpeech({ status: 'listening', reason: 'no-voice' });
            }
            return;
        }
        session.pendingPhrase = null;
        void processPhrase(session, packet);
    }

    async function processPhrase(session, packet) {
        session.speechBusy = true;
        onSpeech({ status: 'transcribing', duration: packet.samples.length / session.context.sampleRate });
        try {
            const waveform = await resample(packet.samples, session.context.sampleRate);
            if (!active(session)) return;
            const result = await session.speechClassifier.classify(waveform);
            if (!['positive', 'negative', 'neutral'].includes(result?.signal)) throw new Error('Invalid speech signal.');
            if (!active(session) || Date.now() - packet.receivedAt > MAX_PHRASE_AGE_MS) return;
            onSpeech({ status: 'result', ...result, duration: waveform.length / SAMPLE_RATE });
            react(session, result.signal, 'words', { transcript: result.transcript });
            report(session);
        } catch (error) {
            if (active(session)) {
                session.speechClassifier?.dispose();
                session.speechClassifier = null;
                session.pendingPhrase = null;
                onSpeech({ status: 'unavailable', message: error.message });
            }
        } finally {
            session.speechBusy = false;
            tryPhrase(session);
        }
    }

    async function processWindow(session, packet) {
        const { samples, startSample, endSample } = packet;
        try {
            let energy = 0;
            for (const value of samples) energy += value * value;
            const rms = Math.sqrt(energy / samples.length);
            let result = 'neutral';
            const profile = SENSITIVITY[sensitivity];
            let diagnostics = { reason: 'quiet', positive: null, negative: null, threshold: profile.threshold, topSound: null };
            if (rms >= MIN_RMS) {
                const waveform = await resample(samples, session.context.sampleRate);
                if (!active(session)) return;
                result = await session.classifier.classify(waveform, profile);
                diagnostics = session.classifier.getDiagnostics?.() || { reason: 'classified' };
                if (!['positive', 'negative', 'neutral'].includes(result)) throw new Error('Invalid audio signal.');
            } else {
                session.classifier.reset?.();
            }
            if (!active(session)) return;
            session.yamnet = { ...diagnostics, signal: result, rms, inputDb: 20 * Math.log10(Math.max(rms, 1e-8)),
                microphone: session.stream.getAudioTracks()[0]?.label || 'Default microphone' };
            session.history.push({ startSample, endSample, diagnostics: session.yamnet });
            session.history = session.history.filter(item => item.endSample >= endSample - session.context.sampleRate * 8);
            // Debounce: one stray window is not a laugh.
            const sound = rms >= MIN_RMS ? directReaction(session.yamnet) : 'neutral';
            session.streak = sound !== 'neutral' && sound === session.streak?.signal
                ? { signal: sound, count: session.streak.count + 1 } : { signal: sound, count: 1 };
            session.soundSignal = sound !== 'neutral' && session.streak.count >= CONFIRM_WINDOWS ? sound : 'neutral';
            react(session, session.soundSignal, 'sound');
            expire(session);
            report(session);
            tryPhrase(session);
        } catch (error) {
            fail(session, error);
        } finally {
            session.busy = false;
            if (!active(session) && session.classifier) {
                session.classifier.dispose();
                session.classifier = null;
            }
        }
    }

    function start({ deviceId = '', processing = true } = {}) {
        if (current) return current.ready;
        if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext || !globalThis.AudioWorkletNode) {
            const error = new Error('Microphone capture needs a supported secure browser page. See the localhost test instructions in README.md.');
            setState('error');
            onError(error);
            return Promise.reject(error);
        }
        // Create/resume immediately so the browser sees the Start click's user activation.
        const context = new AudioContext();
        const session = { context, busy: false, speechBusy: false, history: [], audioEnd: 0, event: null, streak: null, soundSignal: 'neutral' };
        current = session;
        publish('neutral');
        onDiagnostics(null);
        onInput(null);
        setState('starting');
        session.ready = (async () => {
            try {
                await Promise.all([
                    context.resume(),
                    navigator.mediaDevices.getUserMedia({
                        video: false,
                        audio: {
                            channelCount: { ideal: 1 },
                            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
                            echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing
                        }
                    }).then(stream => {
                        if (!active(session)) { stream.getTracks().forEach(track => track.stop()); return; }
                        session.stream = stream;
                        for (const track of stream.getAudioTracks()) {
                            track.addEventListener('ended', () => fail(session, new Error('Microphone disconnected or permission was revoked.')));
                            track.addEventListener('mute', () => fail(session, new Error('Microphone was interrupted. Press Start to resume.')));
                        }
                    }),
                    loadClassifier().then(classifier => {
                        if (!active(session)) { classifier.dispose(); return; }
                        session.classifier = classifier;
                    }),
                    context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url).href)
                ]);
                if (!active(session)) return false;
                session.source = context.createMediaStreamSource(session.stream);
                session.worklet = new AudioWorkletNode(context, 'autoscroll-microphone', {
                    channelCount: 1,
                    channelCountMode: 'explicit',
                    processorOptions: {
                        windowSamples: Math.round(context.sampleRate * WINDOW_SECONDS),
                        hopSamples: Math.round(context.sampleRate * HOP_SECONDS),
                        meterSamples: Math.round(context.sampleRate / 10),
                        // Phrases: short words like "next" count; a 0.15 s pause ends a
                        // phrase; long speech is analyzed at least every 4 s.
                        phraseFrameSamples: loadSpeechClassifier ? Math.round(context.sampleRate * 0.02) : 0,
                        phraseMinSamples: Math.round(context.sampleRate * 0.25),
                        phraseMaxSamples: Math.round(context.sampleRate * 4),
                        phraseSilenceSamples: Math.round(context.sampleRate * 0.15),
                        phrasePreRollSamples: Math.round(context.sampleRate * 0.2)
                    }
                });
                session.worklet.port.onmessage = event => {
                    if (!active(session)) return;
                    const packet = event.data;
                    session.audioEnd = Math.max(session.audioEnd, packet.endSample || packet.startSample || 0);
                    if (packet.type === 'phrase-start') {
                        if (session.speechClassifier) onSpeech({ status: 'hearing' });
                        return;
                    }
                    if (packet.type === 'phrase') {
                        // Keep only the newest phrase waiting; never build a backlog.
                        session.pendingPhrase = { ...packet, receivedAt: Date.now() };
                        tryPhrase(session);
                        return;
                    }
                    if (packet.type === 'level') {
                        expire(session);
                        tryPhrase(session);
                        const track = session.stream.getAudioTracks()[0];
                        onInput({ ...event.data,
                            inputDb: 20 * Math.log10(Math.max(event.data.rms, 1e-8)),
                            microphone: track?.label || 'Default microphone',
                            settings: track?.getSettings?.() || {}
                        });
                        return;
                    }
                    // Drop windows while inference runs; never queue stale reactions.
                    if (packet.type !== 'window' || session.busy) return;
                    session.busy = true;
                    session.inference = processWindow(session, packet);
                };
                session.worklet.onprocessorerror = () => fail(session, new Error('Microphone audio processing stopped. Please restart.'));
                session.source.connect(session.worklet);
                // Worklet outputs silence, so this keeps capture alive without mic feedback.
                session.worklet.connect(context.destination);
                context.onstatechange = () => {
                    if (active(session) && context.state !== 'running') fail(session, new Error('Safari paused the microphone. Press Start to resume.'));
                };
                setState('listening');
                if (loadSpeechClassifier) {
                    session.speechAbort = new AbortController();
                    onSpeech({ status: 'loading' });
                    // Speech model failure must leave sound reactions working.
                    Promise.resolve().then(() => active(session) ? loadSpeechClassifier({ signal: session.speechAbort.signal }) : null).then(classifier => {
                        if (!classifier) return;
                        if (!active(session)) { classifier.dispose(); return; }
                        session.speechClassifier = classifier;
                        onSpeech({ status: 'listening', backend: classifier.backend });
                        tryPhrase(session);
                    }).catch(error => {
                        if (active(session)) onSpeech({ status: 'unavailable', message: error.message });
                    });
                } else { onSpeech({ status: 'disabled' }); }
                return true;
            } catch (error) {
                if (!active(session)) return false;
                fail(session, error);
                throw microphoneError(error);
            }
        })();
        return session.ready;
    }

    return Object.freeze({ start, stop, setSensitivity, getSignal: () => signal, getState: () => state });
}
