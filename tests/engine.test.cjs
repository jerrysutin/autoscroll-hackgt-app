// Run with: node --experimental-vm-modules --test tests/engine.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const enginePath = path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources/engine.js');
const settle = () => new Promise(resolve => setImmediate(resolve));
const TOKEN = 'secret-token';

// engine.js (the hidden frame) with stand-ins for the camera, decision.js, and
// the YouTube page that embeds it.
async function setup() {
    const env = { now: 1000, presence: { known: false, absentMs: 0, lookingAway: false, turn: null }, scores: null, cameraError: null, audio: 'idle', decision: null, camera: 'off', posted: [], starts: [], frames: [],
        cameraState: { modelsReady: true, frames: 1 }, speech: { models: 'ready (GPU)', heard: null } };
    const parent = { postMessage: (message, origin) => env.posted.push({ ...message, origin }) };
    const listeners = {};
    const context = vm.createContext({
        console, Promise, Error, Boolean, JSON, Uint8ClampedArray,
        ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
        createImageBitmap: async image => ({ bitmap: true, width: image.width, height: image.height }),
        Date: class extends Date { static now() { return env.now; } },
        location: { hash: `#${TOKEN}`, ancestorOrigins: ['https://www.youtube.com'] },
        parent,
        window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
        // Each tick is half a second after the previous one.
        setInterval: fn => { env.tick = () => { env.now += 500; fn(); }; }
    });
    const stubs = {
        './facialExpressionClassifier.js': new vm.SyntheticModule(['LOOK_AWAY_TURN', 'getCameraError', 'getCameraState', 'getScores'], function () {
            this.setExport('LOOK_AWAY_TURN', 0.35);
            this.setExport('getCameraState', () => env.cameraState);
            this.setExport('getScores', () => env.scores);
            this.setExport('getCameraError', () => env.cameraError);
        }, { context }),
        './decision.js': new vm.SyntheticModule(['audioState', 'decide', 'getAudioError', 'getFaceInfo', 'getFacePresence', 'getSpeechInfo', 'pushFrame', 'setFaceSensitivity', 'startAudio', 'startCamera'], function () {
            this.setExport('getAudioError', () => env.audioError || null);
            this.setExport('getFacePresence', () => env.presence);
            this.setExport('getFaceInfo', () => env.face);
            this.setExport('setFaceSensitivity', value => { env.sensitivity = value; });
            this.setExport('getSpeechInfo', () => env.speech);
            this.setExport('pushFrame', frame => env.frames.push(frame));
            this.setExport('audioState', () => env.audio);
            this.setExport('decide', () => env.decision);
            this.setExport('startAudio', options => {
                env.starts.push(options);
                env.audio = 'listening';
                return Promise.resolve(true);
            });
            this.setExport('startCamera', options => { env.camera = options?.external ? 'external' : 'own'; });
        }, { context })
    };
    const module = new vm.SourceTextModule(fs.readFileSync(enginePath, 'utf8'), { context, identifier: enginePath });
    await module.link(specifier => stubs[specifier]);
    await module.evaluate();
    await settle();
    // A message from the YouTube page (the frame's parent) unless told otherwise.
    env.receive = (data, { source = parent, token = TOKEN } = {}) => listeners.message({ data: { ...data, token }, source });
    env.ofType = type => env.posted.filter(message => message.type === type);
    return { env };
}

test('uses camera frames from the page and tells the page it is ready, with its token', async () => {
    const { env } = await setup();
    assert.equal(env.camera, 'external', 'never opens the camera itself');
    env.receive({ type: 'AUTOSCROLL_CAMERA_FRAME', width: 320, height: 240, pixels: new ArrayBuffer(320 * 240 * 4) });
    await settle();
    assert.equal(env.frames[0].width, 320, 'raw pixels become a frame for the classifier');
    env.tick();
    assert.deepEqual({ ...env.ofType('AUTOSCROLL_STATUS').at(-1).status.received }, { messages: 1, micPackets: 0, cameraFrames: 1 });
    const [ready] = env.ofType('AUTOSCROLL_ENGINE_READY');
    assert.equal(ready.token, TOKEN);
    assert.equal(ready.origin, 'https://www.youtube.com');
});

test('uses the page microphone as audio input and receives its packets', async () => {
    const { env } = await setup();
    env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000, label: 'MacBook Microphone' });
    const [{ input }] = env.starts;
    assert.equal(input.sampleRate, 48000);
    assert.equal(input.label, 'MacBook Microphone');
    const packets = [];
    input.open({ windowSamples: 46800 }, packet => packets.push(packet), () => {});
    assert.equal(env.ofType('AUTOSCROLL_MIC_CONFIG')[0].options.windowSamples, 46800, 'framing settings go to the page');
    env.receive({ type: 'AUTOSCROLL_MIC_PACKET', packet: { type: 'level', rms: 0.1 } });
    assert.equal(packets[0].rms, 0.1);
    input.close();
    assert.equal(env.ofType('AUTOSCROLL_MIC_STOP').length, 1);
    env.receive({ type: 'AUTOSCROLL_MIC_PACKET', packet: { type: 'level', rms: 0.2 } });
    assert.equal(packets.length, 1, 'no packets after close');
});

test('ignores messages without its token or not from the page', async () => {
    const { env } = await setup();
    env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000 }, { token: 'wrong' });
    env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000 }, { source: { other: true } });
    assert.equal(env.starts.length, 0);
});

test('posts decisions, announces once, and reports status only when it changes', async () => {
    const { env } = await setup();
    env.tick();
    assert.equal(env.ofType('AUTOSCROLL_READY').length, 0, 'not ready without a face or microphone');
    assert.equal(env.ofType('AUTOSCROLL_STATUS').at(-1).status.camera, 'looking for your face');
    env.scores = [1];
    env.decision = true;
    env.tick();
    env.tick();
    assert.equal(env.ofType('AUTOSCROLL_READY').length, 1);
    assert.deepEqual(env.ofType('AUTOSCROLL_DECISION').map(message => message.decision), [true, true]);
    assert.equal(env.ofType('AUTOSCROLL_STATUS').length, 2, 'unchanged status is not re-sent');
    const { status } = env.ofType('AUTOSCROLL_STATUS').at(-1);
    assert.equal(status.camera, 'sees your face');
    assert.equal(status.lastDecision, 'scroll');
    env.decision = null;
    env.tick();
    assert.equal(env.ofType('AUTOSCROLL_DECISION').length, 2, 'no reading, nothing posted');
});

test('a spoken reaction decides even before a face is seen', async () => {
    const { env } = await setup();
    env.audio = 'listening';
    env.decision = true;
    env.tick();
    assert.equal(env.ofType('AUTOSCROLL_READY').length, 1);
    assert.deepEqual(env.ofType('AUTOSCROLL_DECISION').map(message => message.decision), [true]);
});

test('reports camera errors for the popup', async () => {
    const { env } = await setup();
    env.cameraError = 'Starting camera: NotAllowedError';
    env.tick();
    assert.match(env.ofType('AUTOSCROLL_STATUS').at(-1).status.camera, /NotAllowedError/);
});

test('reports face-model loading, missing camera frames, and the last phrase heard', async () => {
    const { env } = await setup();
    env.cameraState = { modelsReady: false, frames: 0 };
    env.tick();
    assert.equal(env.ofType('AUTOSCROLL_STATUS').at(-1).status.camera, 'no camera frames yet');
    env.cameraState = { modelsReady: false, frames: 3 };
    env.tick();
    assert.equal(env.ofType('AUTOSCROLL_STATUS').at(-1).status.camera, 'loading face models…');
    env.speech = { models: 'ready (GPU)', heard: { text: 'this is so boring', signal: 'negative', late: false, at: 1 } };
    env.tick();
    const { speech } = env.ofType('AUTOSCROLL_STATUS').at(-1).status;
    assert.equal(speech.models, 'ready (GPU)');
    assert.equal(speech.heard.text, 'this is so boring');
});

test('the page drives decisions; back-to-back ticks are not doubled', async () => {
    const { env } = await setup();
    env.scores = [1];
    env.decision = true;
    env.now += 500;
    env.receive({ type: 'AUTOSCROLL_TICK' });
    env.receive({ type: 'AUTOSCROLL_TICK' });
    assert.equal(env.ofType('AUTOSCROLL_DECISION').length, 1, 'a tick arriving immediately after is skipped');
    env.now += 500;
    env.receive({ type: 'AUTOSCROLL_TICK' });
    assert.equal(env.ofType('AUTOSCROLL_DECISION').length, 2);
});

test('re-sends unchanged status every 2 seconds so the popup knows it is alive', async () => {
    const { env } = await setup();
    env.tick();
    for (let i = 0; i < 3; i++) env.tick();
    assert.equal(env.ofType('AUTOSCROLL_STATUS').length, 1, 'unchanged within 2 s');
    env.tick();
    assert.equal(env.ofType('AUTOSCROLL_STATUS').length, 2, 'heartbeat after 2 s');
});

test('ignores repeated audio formats once audio analysis has started', async () => {
    const { env } = await setup();
    env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000, label: 'Mic' });
    env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000, label: 'Mic' });
    assert.equal(env.starts.length, 1);
});

test('applies the popup sensitivity from each tick and shows the live negative share', async () => {
    const { env } = await setup();
    env.scores = [1];
    env.face = { negative: 0.123, positive: 0, threshold: 0.18, sensitivity: 'high' };
    env.now += 500;
    env.receive({ type: 'AUTOSCROLL_TICK', faceSensitivity: 'high' });
    assert.equal(env.sensitivity, 'high');
    assert.equal(env.ofType('AUTOSCROLL_STATUS').at(-1).status.camera, 'sees your face · 12% negative (scrolls at 18%)');
});

test('reports face presence on every page tick, and shows looking away', async () => {
    const { env } = await setup();
    env.presence = { known: true, absentMs: 700, lookingAway: true, turn: 0.52 };
    env.receive({ type: 'AUTOSCROLL_TICK' });
    env.receive({ type: 'AUTOSCROLL_TICK' });
    const reports = env.ofType('AUTOSCROLL_PRESENCE');
    assert.equal(reports.length, 2, 'not debounced like decisions');
    assert.equal(reports[0].presence.absentMs, 700);
    assert.equal(env.ofType('AUTOSCROLL_STATUS').at(-1).status.camera, 'looking away · turned 52% (away at 35%)');
});

test('restarts audio analysis 3 s after an error, and reports the error', async () => {
    const { env } = await setup();
    env.audio = 'error';
    env.audioError = { message: 'WebGL context lost', at: env.now };
    env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000, label: 'Mic' });
    assert.equal(env.starts.length, 0, 'waits before retrying');
    env.tick();
    assert.equal(env.ofType('AUTOSCROLL_STATUS').at(-1).status.audioError, 'WebGL context lost');
    env.now += 3000;
    env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000, label: 'Mic' });
    assert.equal(env.starts.length, 1, 'restarted');
});

test('confirms each camera frame, and skips sound windows that arrive too late', async () => {
    const { env } = await setup();
    env.receive({ type: 'AUTOSCROLL_CAMERA_FRAME', width: 2, height: 2, pixels: new ArrayBuffer(16) });
    await settle();
    await settle();
    assert.equal(env.ofType('AUTOSCROLL_FRAME_DONE').length, 1, 'lets the page send the next frame');

    env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000, label: 'Mic' });
    const packets = [];
    env.starts[0].input.open({}, packet => packets.push(packet), () => {});
    env.receive({ type: 'AUTOSCROLL_MIC_PACKET', packet: { type: 'window', capturedAt: env.now - 2500 } });
    env.receive({ type: 'AUTOSCROLL_MIC_PACKET', packet: { type: 'window', capturedAt: env.now - 100 } });
    env.receive({ type: 'AUTOSCROLL_MIC_PACKET', packet: { type: 'phrase', capturedAt: env.now - 2500 } });
    assert.deepEqual(packets.map(packet => packet.type), ['window', 'phrase'], 'late sound window dropped; phrases have their own limit');
});

test('backs off audio restarts: 3 s, then 10 s, then 30 s', async () => {
    const { env } = await setup();
    const format = () => env.receive({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000, label: 'Mic' });
    const failAt = at => { env.audio = 'error'; env.audioError = { message: 'boom', at }; };
    failAt(env.now);
    env.now += 2999; format();
    assert.equal(env.starts.length, 0);
    env.now += 1; format();
    assert.equal(env.starts.length, 1, 'first retry after 3 s');
    failAt(env.now);
    env.now += 9999; format();
    assert.equal(env.starts.length, 1);
    env.now += 1; format();
    assert.equal(env.starts.length, 2, 'second retry after 10 s');
    failAt(env.now);
    env.now += 29999; format();
    assert.equal(env.starts.length, 2);
    env.now += 1; format();
    assert.equal(env.starts.length, 3, 'then every 30 s');
});
