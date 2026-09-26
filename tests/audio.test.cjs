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
        mediaRequests: [], modelRequests: 0, resamples: []
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
        emit(samples) { this.port.onmessage?.({ data: samples }); }
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
        URL, Float32Array, AudioContext, AudioWorkletNode, OfflineAudioContext,
        navigator: { mediaDevices: { getUserMedia: constraints => {
            env.mediaRequests.push(constraints);
            if (options.getUserMedia) return options.getUserMedia(env);
            const stream = makeStream();
            env.streams.push(stream);
            return Promise.resolve(stream);
        } } }
    });
    const module = new vm.SourceTextModule(`${source}\nexport { labelFromScores };`, {
        context,
        identifier: audioPath,
        initializeImportMeta(meta) { meta.url = pathToFileURL(audioPath).href; }
    });
    await module.link(() => { throw new Error('Unexpected module dependency'); });
    await module.evaluate();
    env.labelFromScores = module.namespace.labelFromScores;
    env.detector = module.namespace.createAudioDetector({
        onSignal: signal => env.signals.push(signal),
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
    return env;
}

test('maps YAMNet vocal classes to labels and excludes unrelated sounds', async () => {
    const { labelFromScores } = await setup();
    for (const [label, classes] of [
        ['positive', [13, 15, 16, 17, 18]],
        ['negative', [19, 21, 22, 33]],
        ['neutral', [0, 14, 20, 34]]
    ]) {
        for (const index of classes) {
            const scores = new Float32Array(521);
            scores[index] = 0.9;
            assert.equal(labelFromScores(scores), label, `class ${index}`);
        }
    }
    assert.equal(labelFromScores(new Float32Array(521)), 'neutral');
});

test('weak and conflicting sound scores stay neutral, dominant reactions win', async () => {
    const { labelFromScores } = await setup();
    const scores = new Float32Array(521);
    scores[13] = 0.3;
    assert.equal(labelFromScores(scores), 'neutral');
    scores[13] = 0.8;
    scores[33] = 0.75;
    assert.equal(labelFromScores(scores), 'neutral');
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
    assert.equal(env.worklets[0].settings.processorOptions.windowSamples, 16000);
    assert.match(env.contexts[0].moduleURL, /audio-worklet\.js$/);
    assert.equal(await env.detector.start(), true);
    await env.emit(loudWindow());
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

test('silence publishes neutral without running model inference', async () => {
    const env = await setup();
    await env.detector.start();
    await env.emit(loudWindow());
    assert.equal(env.detector.getSignal(), 'positive');
    await env.emit(new Float32Array(16000));
    assert.equal(env.detector.getSignal(), 'neutral');
    assert.equal(env.classifiers[0].inputs.length, 1);
    await env.detector.stop();
});

test('device audio is resampled to one second of mono 16 kHz before classification', async () => {
    const env = await setup({ sampleRate: 48000 });
    await env.detector.start();
    const input = new Float32Array(48000).fill(0.1);
    await env.emit(input);
    assert.equal(env.worklets[0].settings.processorOptions.windowSamples, 48000);
    const conversion = env.resamples[0];
    assert.equal(conversion.channels, 1);
    assert.equal(conversion.rate, 16000);
    assert.equal(conversion.length, 16000);
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
    await env.emit(loudWindow());
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
    inference.resolve('positive');
    await settle();
    assert.equal(classifier.inputs.length, 1, 'dropped windows must not run later');
    assert.equal(env.detector.getSignal(), 'positive');
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

test('worklet downmixes stereo, emits repeated transferred windows, and outputs silence', () => {
    const messages = [];
    let Processor;
    class AudioWorkletProcessor {
        constructor() {
            this.port = {
                postMessage(samples, transfer) {
                    assert.equal(transfer[0], samples.buffer);
                    messages.push(structuredClone(samples, { transfer }));
                    assert.equal(samples.length, 0, 'simulate actual ArrayBuffer transfer detachment');
                }
            };
        }
    }
    vm.runInNewContext(fs.readFileSync(path.join(resources, 'audio-worklet.js'), 'utf8'), {
        AudioWorkletProcessor, Float32Array,
        registerProcessor(name, value) {
            assert.equal(name, 'autoscroll-microphone');
            Processor = value;
        }
    });
    const worklet = new Processor({ processorOptions: { windowSamples: 4 } });
    const output = [new Float32Array(6).fill(1), new Float32Array(6).fill(1)];
    assert.equal(worklet.process([[
        new Float32Array([0, 2, 4, 6, 8, 10]),
        new Float32Array([2, 4, 6, 8, 10, 12])
    ]], [output]), true);
    assert.deepEqual(Array.from(messages[0]), [1, 3, 5, 7]);
    assert.ok(output.every(channel => channel.every(value => value === 0)));
    worklet.process([[new Float32Array([12, 14, 16, 18, 20, 22])]], [[]]);
    assert.deepEqual(messages.map(samples => Array.from(samples)), [
        [1, 3, 5, 7], [9, 11, 12, 14], [16, 18, 20, 22]
    ]);
    assert.equal(worklet.process([], [[new Float32Array(2).fill(1)]]), true);
    assert.equal(messages.length, 3);
});
