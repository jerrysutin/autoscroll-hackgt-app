/**
 * Local microphone reaction detection using pretrained YAMNet.
 * onSignal receives ONLY "positive", "negative", or "neutral".
 * Call start() from a user gesture in a persistent page, and stop() on pagehide.
 * This recognizes vocal sounds, not spoken sentiment or the user's intent.
 */
const SAMPLE_RATE = 16000;
const WINDOW_SECONDS = 1;
const MIN_RMS = 0.008;
const SCORE_THRESHOLD = 0.35;
const SCORE_MARGIN = 0.15;
// Official YAMNet AudioSet class indices; baby sounds and sighs are excluded.
const POSITIVE_CLASSES = [13, 15, 16, 17, 18]; // laughter, giggle, snicker, belly laugh, chuckle
const NEGATIVE_CLASSES = [19, 21, 22, 33]; // crying, whimper, wail, groan
let runtimePromise;

function labelFromScores(scores) {
    if (scores.length !== 521 || scores.some(score => !Number.isFinite(score))) {
        throw new Error('YAMNet returned invalid sound scores.');
    }
    const positive = Math.max(...POSITIVE_CLASSES.map(index => scores[index]));
    const negative = Math.max(...NEGATIVE_CLASSES.map(index => scores[index]));
    if (positive >= SCORE_THRESHOLD && positive - negative >= SCORE_MARGIN) return 'positive';
    if (negative >= SCORE_THRESHOLD && negative - positive >= SCORE_MARGIN) return 'negative';
    return 'neutral';
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

async function loadYamnet() {
    const tf = await loadRuntime();
    await tf.ready();
    const model = await tf.loadGraphModel(new URL('./audio-assets/yamnet/model.json', import.meta.url).href);
    return {
        async classify(samples) {
            const input = tf.tensor1d(samples);
            let outputs;
            let mean;
            try {
                outputs = await model.executeAsync(input);
                const tensors = Array.isArray(outputs) ? outputs : Object.values(outputs);
                const scores = tensors.find(tensor => tensor.shape.length === 2 && tensor.shape[1] === 521);
                if (!scores) throw new Error('Unexpected YAMNet output: sound scores are missing.');
                mean = scores.mean(0);
                return labelFromScores(await mean.data());
            } finally {
                mean?.dispose();
                tf.dispose(outputs);
                input.dispose();
            }
        },
        dispose: () => model.dispose()
    };
}

async function resample(samples, sourceRate) {
    if (sourceRate === SAMPLE_RATE) return samples;
    // OfflineAudioContext performs band-limited conversion at the actual device rate.
    const context = new OfflineAudioContext(1, SAMPLE_RATE * WINDOW_SECONDS, SAMPLE_RATE);
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
        NotReadableError: 'The microphone could not be opened. Check other apps using it and try again.',
        SecurityError: 'Microphone capture is blocked in this browser context.'
    };
    return new Error(messages[error.name] || error.message || 'Audio detection failed.', { cause: error });
}

/**
 * Example: const audio = createAudioDetector({ onSignal: signal => decision(signal) });
 * await audio.start(); // from a click handler
 * await audio.stop();
 * loadClassifier is an optional adapter for testing/replacing the pretrained model.
 * Its classify(Float32Array of mono 16kHz PCM) returns one of the three labels.
 */
export function createAudioDetector({ onSignal = () => {}, onError = () => {}, onStateChange = () => {}, loadClassifier = loadYamnet } = {}) {
    let current = null;
    let state = 'idle';
    let signal = 'neutral';

    const setState = value => { state = value; onStateChange(value); };
    const publish = value => { signal = value; onSignal(value); };
    const active = session => current === session;

    function release(session) {
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
        setState('idle');
        return session?.inference?.catch(() => {});
    }

    function fail(session, error) {
        if (!active(session)) return;
        stop();
        setState('error');
        onError(microphoneError(error));
    }

    async function processWindow(session, samples) {
        try {
            let energy = 0;
            for (const value of samples) energy += value * value;
            let result = 'neutral';
            if (Math.sqrt(energy / samples.length) >= MIN_RMS) {
                const waveform = await resample(samples, session.context.sampleRate);
                if (!active(session)) return;
                result = await session.classifier.classify(waveform);
                if (!['positive', 'negative', 'neutral'].includes(result)) throw new Error('Invalid audio signal.');
            }
            if (active(session)) publish(result);
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

    function start() {
        if (current) return current.ready;
        if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext || !globalThis.AudioWorkletNode) {
            const error = new Error('Microphone capture needs a supported secure browser page. See the localhost test instructions in README.md.');
            setState('error');
            onError(error);
            return Promise.reject(error);
        }
        // Create/resume immediately so the browser sees the Start click's user activation.
        const context = new AudioContext();
        const session = { context, busy: false };
        current = session;
        publish('neutral');
        setState('starting');
        session.ready = (async () => {
            try {
                await Promise.all([
                    context.resume(),
                    navigator.mediaDevices.getUserMedia({
                        video: false,
                        audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
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
                    processorOptions: { windowSamples: Math.round(context.sampleRate * WINDOW_SECONDS) }
                });
                session.worklet.port.onmessage = event => {
                    // Drop windows while inference runs; never queue stale reactions.
                    if (!active(session) || session.busy) return;
                    session.busy = true;
                    session.inference = processWindow(session, event.data);
                };
                session.worklet.onprocessorerror = () => fail(session, new Error('Microphone audio processing stopped. Please restart.'));
                session.source.connect(session.worklet);
                // Worklet outputs silence, so this keeps capture alive without mic feedback.
                session.worklet.connect(context.destination);
                context.onstatechange = () => {
                    if (active(session) && context.state !== 'running') fail(session, new Error('Safari paused the microphone. Press Start to resume.'));
                };
                setState('listening');
                return true;
            } catch (error) {
                if (!active(session)) return false;
                fail(session, error);
                throw microphoneError(error);
            }
        })();
        return session.ready;
    }

    return Object.freeze({ start, stop, getSignal: () => signal, getState: () => state });
}
