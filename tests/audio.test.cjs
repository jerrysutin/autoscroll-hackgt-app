// Run with: node --experimental-vm-modules --test tests/audio.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const resources = path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources');
const audioPath = path.join(resources, 'audio.js');
const source = fs.readFileSync(audioPath, 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const loudWindow = () => new Float32Array(16000).fill(0.1);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function makeStream() {
    const listeners = new Map();
    const track = {
        stops: 0,
        stop() { this.stops++; },
        addEventListener(name, listener) { listeners.set(name, listener); },
        emit(name) { listeners.get(name)?.(); }
    };
    return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

function makeClassifier(classify = () => 'positive') {
    return {
        inputs: [],
        disposals: 0,
        async classify(samples) { this.inputs.push(samples); return classify(samples); },
        dispose() { this.disposals++; }
    };
}

async function setup(options = {}) {
    const env = {
        contexts: [], worklets: [], streams: [], classifiers: [], signals: [], states: [], errors: [],
        now: 10000, windowEnd: 0, phraseStarts: new Map(), mediaRequests: [], modelRequests: 0, resamples: [], diagnostics: [], inputLevels: []
    };
    class AudioContext {
        constructor() {
            this.sampleRate = options.sampleRate || 16000;
            this.state = 'suspended';
            this.destination = {};
            this.closed = 0;
            this.audioWorklet = { addModule: async url => { this.moduleURL = url; } };
            env.contexts.push(this);
        }
        async resume() { this.state = 'running'; }
        async close() { this.state = 'closed'; this.closed++; }
        createMediaStreamSource(stream) {
            this.stream = stream;
            return this.source = {
                disconnects: 0,
                connect(target) { this.target = target; },
                disconnect() { this.disconnects++; }
            };
        }
    }
    class AudioWorkletNode {
        constructor(context, name, settings) {
            this.context = context;
            this.name = name;
            this.settings = settings;
            this.disconnects = 0;
            this.port = { closes: 0, close() { this.closes++; } };
            env.worklets.push(this);
        }
        connect(target) { this.target = target; }
        disconnect() { this.disconnects++; }
        emit(data) {
            if (data instanceof Float32Array) {
                const startSample = env.windowEnd;
                env.windowEnd += data.length;
                data = { type: 'window', samples: data, startSample, endSample: env.windowEnd };
            }
            this.port.onmessage?.({ data });
        }
    }
    class OfflineAudioContext {
        constructor(channels, length, rate) {
            Object.assign(this, { channels, length, rate, destination: {} });
            env.resamples.push(this);
        }
        createBuffer(channels, length, rate) {
            return this.buffer = {
                channels, length, rate,
                copyToChannel(samples, channel) { this.samples = samples; this.channel = channel; }
            };
        }
        createBufferSource() {
            return this.source = { connect() {}, start() { this.started = true; } };
        }
        async startRendering() {
            this.result = new Float32Array(this.length).fill(0.2);
            return { getChannelData: channel => { assert.equal(channel, 0); return this.result; } };
        }
    }
    const context = vm.createContext({
        Date: class extends Date { static now() { return env.now; } },
        URL, Float32Array, AbortController, AudioContext, AudioWorkletNode, OfflineAudioContext, setTimeout, clearTimeout,
        navigator: { mediaDevices: { getUserMedia: constraints => {
            env.mediaRequests.push(constraints);
            if (options.getUserMedia) return options.getUserMedia(env);
            const stream = makeStream();
            env.streams.push(stream);
            return Promise.resolve(stream);
        } } }
    });
    const module = new vm.SourceTextModule(`${source}\nexport { labelFromScores, prepareWaveform };`, {
        context,
        identifier: audioPath,
        initializeImportMeta(meta) { meta.url = pathToFileURL(audioPath).href; }
    });
    await module.link(() => { throw new Error('Unexpected module dependency'); });
    await module.evaluate();
    env.labelFromScores = module.namespace.labelFromScores;
    env.prepareWaveform = module.namespace.prepareWaveform;
    env.detector = module.namespace.createAudioDetector({
        loadSpeechClassifier: options.loadSpeechClassifier || null,
        onSpeech: data => (env.speech ||= []).push(data),
        onSignal: (signal, detail) => { env.signals.push(signal); (env.details ||= []).push(detail); },
        onLabel: label => (env.labels ||= []).push(label),
        onDiagnostics: data => env.diagnostics.push(data),
        onInput: data => env.inputLevels.push(data),
        onError: error => env.errors.push(error),
        onStateChange: state => env.states.push(state),
        loadClassifier: () => {
            env.modelRequests++;
            if (options.loadClassifier) return options.loadClassifier(env);
            const classifier = makeClassifier(options.classify);
            env.classifiers.push(classifier);
            return Promise.resolve(classifier);
        }
    });
    env.emit = async samples => {
        env.worklets.at(-1).emit(samples);
        await settle();
    };
    // Sound reactions need two consecutive windows; this confirms one.
    env.react = async (make = loudWindow) => {
        await env.emit(make());
        await env.emit(make());
    };
    // Advance past the reaction hold and deliver a meter tick.
    env.expire = async () => {
        env.now += 3000;
        await env.emit({ type: 'level', rms: 0, hasInput: true });
    };
    env.beginPhrase = async id => {
        env.phraseStarts.set(id, env.windowEnd);
        await env.emit({ type: 'phrase-start', utteranceId: id, startSample: env.windowEnd });
    };
    env.endPhrase = id => {
        const startSample = env.phraseStarts.get(id);
        const endSample = env.windowEnd;
        return env.emit({ type: 'phrase', utteranceId: id, startSample, endSample,
            samples: new Float32Array(endSample - startSample).fill(0.1), finalized: 'silence' });
    };
    return env;
}

test('maps YAMNet vocal classes to labels and excludes unrelated sounds', async () => {
    const { labelFromScores } = await setup();
    for (const [label, classes] of [
        ['positive', [13, 15, 16, 17, 18]],
        ['negative', [19, 21, 22, 23, 33, 34]],
        ['neutral', [0, 14, 20, 36]]
    ]) {
        for (const index of classes) {
            const scores = new Float32Array(521);
            scores[index] = 0.9;
            assert.equal(labelFromScores(scores), label, `class ${index}`);
        }
    }
    assert.equal(labelFromScores(new Float32Array(521)), 'neutral');
});

test('reaction scores below 0.01 stay neutral and stronger qualifying scores win', async () => {
    const { labelFromScores } = await setup();
    const scores = new Float32Array(521);
    scores[13] = 0.009;
    assert.equal(labelFromScores(scores), 'neutral');
    scores[13] = 0.011;
    assert.equal(labelFromScores(scores), 'positive');
    scores[13] = 0.2;
    assert.equal(labelFromScores(scores), 'positive', 'weaker laughter now clears the standard threshold');
    scores[13] = 0.8;
    scores[33] = 0.75;
    assert.equal(labelFromScores(scores), 'positive');
    scores[33] = 0.5;
    assert.equal(labelFromScores(scores), 'positive');
    scores[33] = 1;
    assert.equal(labelFromScores(scores), 'negative');
});

test('rejects malformed model scores instead of publishing a reaction', async () => {
    const { labelFromScores } = await setup();
    assert.throws(() => labelFromScores(new Float32Array(520)), /invalid sound scores/);
    for (const value of [NaN, Infinity, -Infinity]) {
        const scores = new Float32Array(521);
        scores[0] = value;
        assert.throws(() => labelFromScores(scores), /invalid sound scores/);
    }
});

test('construction never activates the microphone or loads a model', async () => {
    const env = await setup();
    assert.equal(env.detector.getState(), 'idle');
    assert.equal(env.detector.getSignal(), 'neutral');
    assert.equal(env.mediaRequests.length, 0);
    assert.equal(env.contexts.length, 0);
    assert.equal(env.modelRequests, 0);
});

test('start is idempotent while active, stop releases resources, and restart works', async () => {
    const env = await setup();
    const first = env.detector.start();
    assert.equal(env.detector.start(), first);
    assert.equal(await first, true);
    assert.equal(env.detector.getState(), 'listening');
    assert.equal(env.mediaRequests.length, 1);
    assert.equal(env.mediaRequests[0].video, false);
    assert.equal(env.modelRequests, 1);
    assert.equal(env.worklets[0].name, 'autoscroll-microphone');
    assert.equal(env.worklets[0].settings.processorOptions.windowSamples, 15600);
    assert.match(env.contexts[0].moduleURL, /audio-worklet\.js$/);
    assert.equal(await env.detector.start(), true);
    await env.react();
    assert.equal(env.detector.getSignal(), 'positive');
    await env.detector.stop();
    await env.detector.stop();
    assert.equal(env.detector.getState(), 'idle');
    assert.equal(env.detector.getSignal(), 'neutral');
    assert.equal(env.streams[0].track.stops, 1);
    assert.equal(env.contexts[0].closed, 1);
    assert.equal(env.contexts[0].source.disconnects, 1);
    assert.equal(env.worklets[0].disconnects, 1);
    assert.equal(env.worklets[0].port.closes, 1);
    assert.equal(env.worklets[0].port.onmessage, null);
    assert.equal(env.classifiers[0].disposals, 1);
    assert.equal(await env.detector.start(), true);
    assert.equal(env.mediaRequests.length, 2);
    await env.detector.stop();
    assert.equal(env.classifiers[1].disposals, 1);
});

test('a confirmed reaction is held through silence, then expires to neutral without inference', async () => {
    const env = await setup();
    await env.detector.start();
    await env.emit(loudWindow());
    assert.equal(env.detector.getSignal(), 'neutral', 'one window is not enough');
    await env.emit(loudWindow());
    assert.equal(env.detector.getSignal(), 'positive');
    await env.emit(new Float32Array(16000));
    assert.equal(env.detector.getSignal(), 'positive', 'silence does not cut a reaction short');
    await env.expire();
    assert.equal(env.detector.getSignal(), 'neutral');
    assert.equal(env.classifiers[0].inputs.length, 2);
    assert.deepEqual(env.signals, ['positive'], 'decision output never reports neutral');
    assert.deepEqual(env.labels, ['positive', 'neutral'], 'the display label returns to neutral');
    await env.detector.stop();
});

test('device audio preserves the complete patch duration when resampled to mono 16 kHz', async () => {
    const env = await setup({ sampleRate: 48000 });
    await env.detector.start();
    const input = new Float32Array(46800).fill(0.1);
    await env.emit(input);
    assert.equal(env.worklets[0].settings.processorOptions.windowSamples, 46800);
    const conversion = env.resamples[0];
    assert.equal(conversion.channels, 1);
    assert.equal(conversion.rate, 16000);
    assert.equal(conversion.length, 15600);
    assert.equal(conversion.buffer.rate, 48000);
    assert.equal(conversion.buffer.samples, input);
    assert.equal(conversion.source.started, true);
    assert.equal(env.classifiers[0].inputs[0], conversion.result);
    await env.detector.stop();
});

test('permission denial closes the context and disposes a late model', async () => {
    const model = deferred();
    const classifier = makeClassifier();
    const env = await setup({
        getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
        loadClassifier: () => model.promise
    });
    await assert.rejects(env.detector.start(), /Microphone access was denied/);
    assert.equal(env.detector.getState(), 'error');
    assert.equal(env.errors.length, 1);
    assert.equal(env.contexts[0].closed, 1);
    model.resolve(classifier);
    await settle();
    assert.equal(classifier.disposals, 1);
    assert.equal(env.worklets.length, 0);
});

test('stopping while permission and model loading are pending cleans up late results', async () => {
    const permission = deferred();
    const model = deferred();
    const stream = makeStream();
    const classifier = makeClassifier();
    const env = await setup({ getUserMedia: () => permission.promise, loadClassifier: () => model.promise });
    const start = env.detector.start();
    await env.detector.stop();
    assert.equal(env.contexts[0].closed, 1);
    permission.resolve(stream);
    model.resolve(classifier);
    assert.equal(await start, false);
    assert.equal(stream.track.stops, 1);
    assert.equal(classifier.disposals, 1);
    assert.equal(env.detector.getState(), 'idle');
    assert.equal(env.worklets.length, 0);
    assert.deepEqual(env.errors, []);
});

test('a model load failure stops a microphone granted later', async () => {
    const permission = deferred();
    const stream = makeStream();
    const env = await setup({
        getUserMedia: () => permission.promise,
        loadClassifier: () => Promise.reject(new Error('Model unavailable'))
    });
    await assert.rejects(env.detector.start(), /Model unavailable/);
    permission.resolve(stream);
    await settle();
    assert.equal(stream.track.stops, 1);
    assert.equal(env.contexts[0].closed, 1);
    assert.equal(env.detector.getState(), 'error');
});

test('stopped inference never publishes into a new session and disposes after completion', async () => {
    const inference = deferred();
    const oldClassifier = makeClassifier(() => inference.promise);
    const newClassifier = makeClassifier(() => 'positive');
    const classifiers = [oldClassifier, newClassifier];
    const env = await setup({ loadClassifier: () => Promise.resolve(classifiers.shift()) });
    await env.detector.start();
    await env.emit(loudWindow());
    assert.equal(oldClassifier.inputs.length, 1);
    const stop = env.detector.stop();
    assert.equal(oldClassifier.disposals, 0, 'model must remain alive while inference uses it');
    assert.equal(env.streams[0].track.stops, 1, 'microphone stops immediately');
    await env.detector.start();
    await env.react();
    assert.equal(env.detector.getSignal(), 'positive');
    const publishedBefore = [...env.signals];
    inference.resolve('negative');
    await stop;
    assert.equal(oldClassifier.disposals, 1);
    assert.equal(newClassifier.disposals, 0);
    assert.deepEqual(env.signals, publishedBefore, 'stale result must not overwrite current signal');
    assert.equal(env.detector.getState(), 'listening');
    await env.detector.stop();
    assert.equal(newClassifier.disposals, 1);
});

test('busy inference drops incoming windows instead of queuing old reactions', async () => {
    const inference = deferred();
    const classifier = makeClassifier(() => classifier.inputs.length === 1 ? inference.promise : 'negative');
    const env = await setup({ loadClassifier: () => Promise.resolve(classifier) });
    await env.detector.start();
    await env.emit(loudWindow());
    await env.emit(loudWindow());
    await env.emit(loudWindow());
    assert.equal(classifier.inputs.length, 1);
    inference.resolve('negative');
    await settle();
    assert.equal(classifier.inputs.length, 1, 'dropped windows must not run later');
    assert.equal(env.detector.getSignal(), 'neutral', 'dropped windows do not count toward confirmation');
    await env.emit(loudWindow());
    assert.equal(classifier.inputs.length, 2);
    assert.equal(env.detector.getSignal(), 'negative');
    await env.detector.stop();
});

test('microphone unplugging stops capture and reports an actionable error', async () => {
    const env = await setup();
    await env.detector.start();
    await env.emit(loudWindow());
    const queuedHandler = env.worklets[0].port.onmessage;
    env.streams[0].track.emit('ended');
    assert.equal(env.detector.getState(), 'error');
    assert.equal(env.detector.getSignal(), 'neutral');
    assert.match(env.errors[0].message, /disconnected or permission was revoked/);
    assert.equal(env.contexts[0].closed, 1);
    assert.equal(env.classifiers[0].disposals, 1);
    queuedHandler({ data: loudWindow() });
    await settle();
    assert.equal(env.classifiers[0].inputs.length, 1);
});

test('invalid classifier labels fail safely and clear previous reactions', async () => {
    const env = await setup({ classify: () => 'unknown' });
    await env.detector.start();
    await env.emit(loudWindow());
    assert.equal(env.detector.getState(), 'error');
    assert.equal(env.detector.getSignal(), 'neutral');
    assert.match(env.errors[0].message, /Invalid audio signal/);
    assert.equal(env.classifiers[0].disposals, 1);
    assert.equal(env.streams[0].track.stops, 1);
    assert.ok(env.signals.every(value => ['positive', 'negative', 'neutral'].includes(value)));
});

test('quiet reactions reach the model while near-silence still skips it', async () => {
    const env = await setup();
    await env.detector.start();
    await env.react(() => new Float32Array(16000).fill(0.004));
    assert.equal(env.classifiers[0].inputs.length, 2);
    assert.equal(env.detector.getSignal(), 'positive');
    assert.ok(env.diagnostics.at(-1).inputDb < -40);
    await env.emit(new Float32Array(16000).fill(0.0001));
    assert.equal(env.classifiers[0].inputs.length, 2);
    assert.equal(env.diagnostics.at(-1).reason, 'quiet');
    await env.expire();
    assert.equal(env.detector.getSignal(), 'neutral');
    await env.detector.stop();
    assert.equal(env.diagnostics.at(-1), null);
});

test('ties and weak negative evidence stay neutral; the exact threshold qualifies', async () => {
    const { labelFromScores, detector } = await setup();
    const scores = new Float32Array(521);
    assert.equal(labelFromScores(scores), 'neutral');
    scores[13] = scores[33] = 0.2;
    assert.equal(labelFromScores(scores), 'neutral');
    scores[13] = 0;
    scores[33] = 0.009;
    assert.equal(labelFromScores(scores), 'neutral');
    const exactScores = new Array(521).fill(0);
    exactScores[33] = 0.01;
    assert.equal(labelFromScores(exactScores), 'negative');
    exactScores[33] = 0;
    exactScores[13] = 0.01;
    assert.equal(labelFromScores(exactScores), 'positive');
    assert.throws(() => detector.setSensitivity('unknown'), /Unknown audio sensitivity/);
});

test('sensitivity changes are passed to the classifier without changing signal output', async () => {
    const options = [];
    const classifier = makeClassifier();
    classifier.classify = async (samples, profile) => { options.push(profile); return 'neutral'; };
    const env = await setup({ loadClassifier: async () => classifier });
    await env.detector.start();
    await env.emit(loudWindow());
    assert.equal(options[0].threshold, 0.01);
    env.detector.setSensitivity('high');
    await env.emit(loudWindow());
    assert.equal(options[1].threshold, 0.01);
    assert.equal(env.detector.getSignal(), 'neutral');
    await env.detector.stop();
});


test('chosen microphone is requested exactly and processing can be disabled', async () => {
    const env = await setup();
    await env.detector.start({ deviceId: 'built-in-mic', processing: false });
    const constraints = env.mediaRequests[0];
    assert.equal(constraints.audio.deviceId.exact, 'built-in-mic');
    for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) assert.equal(constraints.audio[key], false);
    assert.equal(constraints.video, false);
    await env.detector.stop();
});

test('meter updates while AI inference is busy and stops when capture stops', async () => {
    const inference = deferred();
    const env = await setup({ classify: () => inference.promise });
    await env.detector.start();
    await env.emit(loudWindow());
    const handler = env.worklets[0].port.onmessage;
    handler({ data: { type: 'level', rms: 0.1, hasInput: true } });
    assert.equal(env.inputLevels.at(-1).inputDb, -20);
    assert.equal(env.inputLevels.at(-1).hasInput, true);
    assert.equal(env.classifiers[0].inputs.length, 1);
    const stopped = env.detector.stop();
    assert.equal(env.inputLevels.at(-1), null);
    const count = env.inputLevels.length;
    handler({ data: { type: 'level', rms: 0.2, hasInput: true } });
    assert.equal(env.inputLevels.length, count);
    inference.resolve('positive');
    await stopped;
});

test('missing selected microphone reports an actionable error without falling back silently', async () => {
    const env = await setup({ getUserMedia: () => Promise.reject(Object.assign(new Error('device missing'), { name: 'OverconstrainedError' })) });
    await assert.rejects(env.detector.start({ deviceId: 'removed' }), /selected microphone is unavailable/);
    assert.equal(env.detector.getState(), 'error');
});

test('quiet audible waveforms get bounded gain without changing the captured samples', async () => {
    const { prepareWaveform } = await setup();
    const samples = new Float32Array(16000).map((_, i) => 0.004 * Math.sin(2 * Math.PI * 440 * i / 16000));
    const original = samples.slice();
    const result = prepareWaveform(samples);
    assert.ok(result.inputGain > 1 && result.inputGain <= 32);
    assert.ok(Math.abs(result.modelRms - 0.05) < 1e-6);
    assert.deepEqual(samples, original);
    assert.ok(result.samples.every(value => Math.abs(value) <= 0.95));
});

test('normalization does not boost near-silence or already loud audio, and respects peak headroom', async () => {
    const { prepareWaveform } = await setup();
    assert.equal(prepareWaveform(new Float32Array(16000)).inputGain, 1);
    assert.equal(prepareWaveform(new Float32Array(16000).fill(0.0001)).inputGain, 1);
    assert.equal(prepareWaveform(new Float32Array(16000).fill(0.2)).inputGain, 1);
    const quiet = prepareWaveform(new Float32Array(16000).fill(0.0011));
    assert.equal(quiet.inputGain, 32);
    const spike = new Float32Array(16000).fill(0.003);
    spike[0] = 0.8;
    const limited = prepareWaveform(spike);
    assert.ok(limited.inputGain <= 0.95 / 0.8);
    assert.ok(limited.samples.every(value => Math.abs(value) <= 0.951));
    assert.throws(() => prepareWaveform(new Float32Array([NaN])), /Invalid microphone samples/);
});


test('near-silence and sensitivity changes reset accumulated classifier evidence', async () => {
    const classifier = makeClassifier();
    let resets = 0;
    classifier.reset = () => { resets++; };
    const env = await setup({ loadClassifier: async () => classifier });
    await env.detector.start();
    assert.equal(env.worklets[0].settings.processorOptions.hopSamples, 3840);
    await env.emit(loudWindow());
    await env.emit(new Float32Array(15600));
    assert.equal(resets, 1);
    assert.equal(env.detector.getSignal(), 'neutral');
    env.detector.setSensitivity('high');
    assert.equal(resets, 2);
    await env.detector.stop();
});

test('speech model failure leaves sound reactions listening and reports why', async () => {
    const env = await setup({ loadSpeechClassifier: async () => { throw new Error('assets missing'); } });
    await env.detector.start();
    await env.react();
    assert.equal(env.detector.getSignal(), 'positive');
    assert.equal(env.detector.getState(), 'listening');
    assert.equal(env.speech.at(-1).status, 'unavailable');
    assert.equal(env.speech.at(-1).message, 'assets missing');
    await env.detector.stop();
});

test('stopping aborts speech model loading and disposes a late adapter', async () => {
    const loading = deferred();
    let aborted = false;
    let disposed = false;
    const env = await setup({ loadSpeechClassifier: ({ signal }) => {
        signal.addEventListener('abort', () => { aborted = true; });
        return loading.promise;
    } });
    await env.detector.start();
    await settle();
    await env.detector.stop();
    assert.equal(aborted, true);
    const count = env.speech.length;
    loading.resolve({ dispose() { disposed = true; } });
    await settle();
    assert.equal(disposed, true);
    assert.equal(env.speech.length, count);
});

test('YAMNet uses the restored 0.01 cutoff with no extra negative margin', async () => {
    const { labelFromScores } = await setup();
    const scores = new Array(521).fill(0);
    scores[33] = 0.01;
    assert.equal(labelFromScores(scores), 'negative');
    scores[13] = 0.0099;
    assert.equal(labelFromScores(scores), 'negative');
    scores[13] = 0.0101;
    assert.equal(labelFromScores(scores), 'positive');
});


function speechClassifier(signal = () => 'neutral') {
    const classifier = makeClassifier(signal);
    classifier.getDiagnostics = () => ({ topIndex: 0, topScore: 0.8, speechScore: 0.8, positive: 0, negative: 0 });
    return classifier;
}


function words(signal, transcript = 'test phrase') {
    return { signal, transcript, reason: signal === 'neutral' ? 'neutral-statement' : 'sentiment',
        scores: { positive: 0, neutral: 0, negative: 0 } };
}

function speechAdapter(classify) {
    const adapter = { calls: 0, disposals: 0, classify(samples) { adapter.calls++; return classify(samples, adapter.calls); },
        dispose() { adapter.disposals++; } };
    return adapter;
}

test('a short negative statement drives the output after its pause, then expires', async () => {
    const pending = deferred();
    const speech = speechAdapter(() => pending.promise);
    const env = await setup({ loadClassifier: async () => speechClassifier(), loadSpeechClassifier: async () => speech });
    await env.detector.start();
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    assert.equal(env.speech.at(-1).status, 'transcribing');
    await env.emit(new Float32Array(15600));
    pending.resolve(words('negative', 'this is so boring'));
    await settle();
    assert.equal(env.detector.getSignal(), 'negative');
    assert.equal(env.speech.at(-1).status, 'result');
    assert.equal(env.speech.at(-1).transcript, 'this is so boring');
    assert.equal(env.diagnostics.at(-1).source, 'words');
    env.now += 2900;
    await env.emit({ type: 'level', rms: 0, hasInput: true });
    assert.equal(env.detector.getSignal(), 'negative', 'held for three seconds');
    env.now += 100;
    await env.emit({ type: 'level', rms: 0, hasInput: true });
    assert.equal(env.detector.getSignal(), 'neutral');
    await env.detector.stop();
});

test('starting to speak and neutral statements never clear a held reaction', async () => {
    let result = words('positive', 'I love this');
    const speech = speechAdapter(async () => result);
    const env = await setup({ loadClassifier: async () => speechClassifier(), loadSpeechClassifier: async () => speech });
    await env.detector.start();
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    assert.equal(env.detector.getSignal(), 'positive');
    result = words('neutral', 'hold on');
    await env.beginPhrase(2);
    assert.equal(env.detector.getSignal(), 'positive', 'phrase start does not reset output');
    await env.emit(loudWindow());
    await env.endPhrase(2);
    assert.equal(speech.calls, 2);
    assert.equal(env.detector.getSignal(), 'positive');
    assert.deepEqual(env.signals, ['positive']);
    await env.detector.stop();
});

test('the newest reaction wins across sounds and words', async () => {
    const speech = speechAdapter(async () => words('negative', 'skip this'));
    const laughter = makeClassifier(() => 'positive');
    laughter.getDiagnostics = () => ({ topIndex: 13, topScore: 0.5, positive: 0.5 });
    const env = await setup({ loadClassifier: async () => laughter, loadSpeechClassifier: async () => speech });
    await env.detector.start();
    await env.react();
    assert.equal(env.detector.getSignal(), 'positive');
    assert.equal(env.diagnostics.at(-1).source, 'sound');
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    assert.equal(env.detector.getSignal(), 'negative');
    await env.detector.stop();
});

test('a phrase waits for pending YAMNet voice evidence instead of dropping short speech', async () => {
    const yamnet = deferred();
    const speech = speechAdapter(async () => words('negative'));
    const env = await setup({ loadClassifier: async () => speechClassifier(() => yamnet.promise), loadSpeechClassifier: async () => speech });
    await env.detector.start();
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    assert.equal(speech.calls, 0);
    yamnet.resolve('neutral');
    await settle();
    assert.equal(speech.calls, 1);
    assert.equal(env.detector.getSignal(), 'negative');
    await env.detector.stop();
});

test('while busy, only the newest waiting phrase is analyzed next', async () => {
    const first = deferred();
    const speech = speechAdapter((samples, call) => call === 1 ? first.promise : words('positive'));
    const env = await setup({ loadClassifier: async () => speechClassifier(), loadSpeechClassifier: async () => speech });
    await env.detector.start();
    for (const id of [1, 2, 3]) {
        await env.beginPhrase(id);
        await env.emit(loudWindow());
        await env.endPhrase(id);
    }
    assert.equal(speech.calls, 1);
    first.resolve(words('negative'));
    await settle();
    assert.equal(speech.calls, 2, 'phrase 2 was replaced by phrase 3');
    assert.equal(env.detector.getSignal(), 'positive');
    await env.detector.stop();
});

test('music or noise is never transcribed, and results after stop are ignored', async () => {
    const pending = deferred();
    let topIndex = 137;
    const classifier = makeClassifier(() => 'neutral');
    classifier.getDiagnostics = () => ({ topIndex });
    const speech = speechAdapter(() => pending.promise);
    const env = await setup({ loadClassifier: async () => classifier, loadSpeechClassifier: async () => speech });
    await env.detector.start();
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    await env.emit(new Float32Array(48000));
    assert.equal(speech.calls, 0, 'Whisper invents words for music, so it never sees it');
    assert.equal(env.speech.at(-1).reason, 'no-voice');
    topIndex = 12;
    await env.beginPhrase(2);
    await env.emit(loudWindow());
    await env.endPhrase(2);
    assert.equal(speech.calls, 1);
    await env.detector.stop();
    const count = env.signals.length;
    pending.resolve(words('negative'));
    await settle();
    assert.equal(env.signals.length, count);
    assert.equal(env.detector.getSignal(), 'neutral');
});

test('a phrase result that arrives too late is dropped', async () => {
    const pending = deferred();
    const speech = speechAdapter(() => pending.promise);
    const env = await setup({ loadClassifier: async () => speechClassifier(), loadSpeechClassifier: async () => speech });
    await env.detector.start();
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    env.now += 8001;
    pending.resolve(words('negative'));
    await settle();
    assert.equal(env.detector.getSignal(), 'neutral');
    await env.detector.stop();
});

test('a groan mixed with louder speech is a negative sound; tiny incidental scores are not', async () => {
    for (const [negative, expected] of [[0.3, 'negative'], [0.03, 'neutral']]) {
        const classifier = speechClassifier(() => 'neutral');
        classifier.getDiagnostics = () => ({ topIndex: 0, speechScore: 0.6, topScore: 0.6, positive: 0.01, negative, rawNegative: negative });
        const env = await setup({ loadClassifier: async () => classifier });
        await env.detector.start();
        await env.react();
        assert.equal(env.detector.getSignal(), expected, `negative score ${negative}`);
        await env.detector.stop();
    }
    for (const topIndex of [23, 33, 34]) {
        const classifier = makeClassifier(() => 'negative');
        classifier.getDiagnostics = () => ({ topIndex, topScore: 0.5, negative: 0.5 });
        const env = await setup({ loadClassifier: async () => classifier });
        await env.detector.start();
        await env.react();
        assert.equal(env.detector.getSignal(), 'negative', `class ${topIndex}`);
        await env.detector.stop();
    }
});

test('a sigh or groan phrase is also transcribed, since YAMNet counts it as a voice', async () => {
    const classifier = makeClassifier(() => 'negative');
    classifier.getDiagnostics = () => ({ topIndex: 33, topScore: 0.5, negative: 0.5 });
    const speech = speechAdapter(async () => words('negative', 'ugh'));
    const env = await setup({ loadClassifier: async () => classifier, loadSpeechClassifier: async () => speech });
    await env.detector.start();
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    assert.equal(speech.calls, 1);
    await env.detector.stop();
});


test('listen() resolves with the next positive or negative reaction, never neutral', async () => {
    let result = words('neutral', 'hold on');
    const speech = speechAdapter(async () => result);
    const env = await setup({ loadClassifier: async () => speechClassifier(), loadSpeechClassifier: async () => speech });
    await env.detector.start();
    let settled = null;
    const request = env.detector.listen({ timeoutMs: 60000 }).then(value => { settled = value; });
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    await settle();
    assert.equal(settled, null, 'a neutral statement does not answer the request');
    assert.deepEqual(env.signals, []);
    result = words('negative', 'skip this');
    await env.beginPhrase(2);
    await env.emit(loudWindow());
    await env.endPhrase(2);
    await request;
    assert.equal(settled, 'negative');
    assert.equal(env.details.at(-1).source, 'words');
    assert.equal(env.details.at(-1).transcript, 'skip this');
    await env.detector.stop();
});

test('listen() only counts reactions after the request, and each phrase is a new reaction', async () => {
    const speech = speechAdapter(async () => words('negative', 'boring'));
    const env = await setup({ loadClassifier: async () => speechClassifier(), loadSpeechClassifier: async () => speech });
    await env.detector.start();
    await env.beginPhrase(1);
    await env.emit(loudWindow());
    await env.endPhrase(1);
    assert.equal(env.detector.getSignal(), 'negative', 'an earlier reaction is still held');
    let settled = 'pending';
    const request = env.detector.listen({ timeoutMs: 60000 }).then(value => { settled = value; });
    await settle();
    assert.equal(settled, 'pending', 'a reaction from before the request does not answer it');
    await env.beginPhrase(2);
    await env.emit(loudWindow());
    await env.endPhrase(2);
    await request;
    assert.equal(settled, 'negative');
    assert.deepEqual(env.signals, ['negative', 'negative'], 'two negative statements are two reactions');
    await env.detector.stop();
});

test('a continuing laugh is one reaction until its hold expires', async () => {
    const env = await setup();
    await env.detector.start();
    await env.react();
    await env.emit(loudWindow());
    await env.emit(loudWindow());
    assert.deepEqual(env.signals, ['positive']);
    await env.expire();
    await env.react();
    assert.deepEqual(env.signals, ['positive', 'positive'], 'a new laugh after the hold is a new reaction');
    await env.detector.stop();
});

test('listen() gives null on timeout, abort, or stop, and rejects before start', async () => {
    const env = await setup();
    await assert.rejects(env.detector.listen(), /Start the microphone/);
    await env.detector.start();
    assert.equal(await env.detector.listen({ timeoutMs: 5 }), null);
    const controller = new AbortController();
    const aborted = env.detector.listen({ timeoutMs: 60000, signal: controller.signal });
    controller.abort();
    assert.equal(await aborted, null);
    const stopped = env.detector.listen({ timeoutMs: 60000 });
    await env.detector.stop();
    assert.equal(await stopped, null);
    assert.deepEqual(env.signals, []);
});
