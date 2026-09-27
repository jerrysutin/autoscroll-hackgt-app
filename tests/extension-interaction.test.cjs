const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources/extension-interaction.js'), 'utf8');

function setup({ host = 'www.youtube.com', pathname = '/shorts/example', hidden = false, videos = true, button = true, stored = {}, micError = null, cameraError = null, sendError = null } = {}) {
    const actions = [];
    const container = {
        parentElement: null, scrollHeight: 2400, clientHeight: 800, scrollTop: 0,
        scrollBy: options => actions.push(['scroll', options.top])
    };
    const video = {
        paused: false, ended: false, isConnected: true, plays: 0,
        currentTime: 0, duration: 10, currentSrc: 'blob:https://www.youtube.com/short-1',
        pause() { this.paused = true; },
        play() { this.paused = false; this.plays++; return Promise.resolve(); },
        parentElement: container,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 700, width: 400, height: 700 }),
        closest: () => null
    };
    const nextButton = {
        ...video, disabled: false, getAttribute: () => null,
        click: () => actions.push(['click'])
    };
    const clock = { now: 10000 };
    const store = { ...stored };
    const saved = [];
    const mic = {};
    const cam = {};
    const requests = [];
    let tokens = 0;
    const listeners = {};
    const timers = [];
    const appended = [];
    // Minimal DOM element: enough for the button frame and the pop-up.
    const element = tag => {
        const node = { tag, style: {}, attributes: {}, children: [], isConnected: false,
            setAttribute(name, value) { this.attributes[name] = value; },
            // The src attribute is exactly what the script set; tests can make the
            // src property differ, as a browser may normalize it.
            getAttribute(name) { return name === 'src' ? this.srcAttribute ?? this.src : this.attributes[name]; },
            append(...nodes) { this.children.push(...nodes); },
            attachShadow() { return node.shadow = element('#shadow'); },
            remove() { node.isConnected = false; node.removed = true; },
            // <video> and <canvas> parts used by the camera.
            readyState: 4, videoWidth: 640, videoHeight: 480,
            play: async () => {},
            getContext: () => ({
                drawImage: (...args) => { cam.drawn = args; },
                getImageData: (x, y, width, height) => ({ width, height, data: { buffer: new ArrayBuffer(width * height * 4) } })
            }),
            contentWindow: tag === 'iframe' ? { received: [], postMessage(message, origin, transfer) {
                if (sendError) throw sendError;
                this.received.push({ message, origin });
            } } : undefined };
        return node;
    };
    const context = {
        Date: { now: () => clock.now },
        URL,
        setInterval: (fn, ms) => timers.push({ fn, ms }),
        setTimeout: (fn, ms) => timers.push({ fn, ms, once: true }),
        clearTimeout: () => {},
        clearInterval: () => {},
        browser: {
            runtime: { getURL: file => `safari-web-extension://abc123/${file}` },
            storage: {
                local: {
                    get: async () => ({ ...store }),
                    set: async values => { Object.assign(store, values); saved.push(values); }
                },
                onChanged: { addListener: fn => { listeners.storage = fn; } }
            }
        },
        crypto: { randomUUID: () => `token-${++tokens}` },
        navigator: { mediaDevices: { getUserMedia: async constraints => {
            requests.push(constraints.video ? 'camera' : 'microphone');
            if (constraints.video) {
                if (cameraError) throw cameraError;
                const track = { label: 'FaceTime HD Camera', stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
                return cam.stream = { getTracks: () => [track], getVideoTracks: () => [track] };
            }
            if (micError) throw micError;
            const track = { label: 'MacBook Microphone', stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
            return mic.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
        } } },
        createImageBitmap: async canvas => ({ bitmap: true, width: canvas.width, height: canvas.height }),
        AudioContext: class {
            constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = {}; mic.context = this; }
            createMediaStreamSource() { return { connect() {} }; }
            createScriptProcessor() { return mic.node = { connect() {}, disconnect() { this.disconnected = true; } }; }
            resume() { return Promise.resolve(); }
            close() { this.closed = true; return Promise.resolve(); }
        },
        AutoScrollFramer: class {
            constructor(options, post) { mic.framer = this; this.options = options; this.post = post; }
            push(channels) { this.post({ type: 'level', rms: channels[0][0] }, []); }
        },
        window: { addEventListener: (name, fn) => { listeners[`window:${name}`] = fn; } },
        location: { hostname: host, pathname },
        innerWidth: 1200, innerHeight: 800,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto' }),
        document: {
            visibilityState: hidden ? 'hidden' : 'visible',
            querySelectorAll: selector => selector === 'video' ? (videos ? [video] : []) : (button ? [nextButton] : []),
            scrollingElement: null,
            addEventListener: (name, fn) => { listeners[name] = fn; },
            createElement: element,
            documentElement: { append: node => { node.isConnected = true; appended.push(node); } },
            body: null
        }
    };
    vm.runInNewContext(source, context);
    const tick = () => timers.filter(timer => timer.ms === 1000).forEach(timer => timer.fn());
    const frames = () => appended.filter(node => node.tag === 'iframe' && !node.removed);
    // A message as if posted by the engine frame (with its token unless told otherwise).
    const post = (data, { token = `token-${tokens}` } = {}) => listeners['window:message']({ data: { ...data, token } });
    const sentToFrame = () => frames()[0]?.contentWindow.received.map(entry => entry.message) || [];
    return { api: context.AutoScroll, actions, container, video, context, clock, listeners, tick, appended, timers, frames, post, store, saved, mic, cam, requests, sentToFrame };
}

test('only navigates Shorts routes, including after SPA navigation', () => {
    const env = setup({ pathname: '/watch' });
    assert.equal(env.api.next().reason, 'unsupported-page');
    env.context.location.pathname = '/shorts/new';
    assert.equal(env.api.next().advanced, true);
});

test('requires a visible video and foreground document', () => {
    assert.equal(setup({ hidden: true }).api.next().reason, 'no-visible-short');
    assert.equal(setup({ videos: false }).api.next().reason, 'no-visible-short');
    const env = setup();
    env.video.getBoundingClientRect = () => ({ left: 0, top: 900, right: 400, bottom: 1600, width: 400, height: 700 });
    assert.equal(env.api.next().reason, 'no-visible-short');
    assert.equal(env.actions.length, 0);
});

test('uses YouTube navigation on consecutive calls', () => {
    const env = setup();
    assert.equal(env.api.next().method, 'next-button');
    assert.equal(env.api.next().advanced, true);
    assert.equal(env.actions.length, 2);
});

test('scrolls the Shorts container by one viewport when YouTube controls are missing', () => {
    const env = setup({ button: false });
    assert.equal(env.api.next().method, 'scroll');
    assert.deepEqual(env.actions, [['scroll', 800]]);
});

test('does not scroll at the end of the feed or without a scroll container', () => {
    const env = setup({ button: false });
    env.container.scrollTop = 1600;
    assert.equal(env.api.next().reason, 'end-of-feed');
    env.container.scrollHeight = 800;
    assert.equal(env.api.next().reason, 'no-scroll-container');
    assert.equal(env.actions.length, 0);
});

test('falls back to the next YouTube renderer when the button is absent', () => {
    const env = setup({ button: false });
    env.video.closest = () => ({ nextElementSibling: {
        matches: () => true,
        scrollIntoView: () => env.actions.push(['next-reel'])
    } });
    assert.equal(env.api.next().method, 'next-reel');
    assert.deepEqual(env.actions, [['next-reel']]);
});


test('a scroll decision moves to the next reel; watch and no reading do nothing', () => {
    const env = setup();
    assert.equal(env.api.applyDecision(false).reason, 'watch');
    assert.equal(env.api.applyDecision(null).reason, 'no-decision');
    assert.equal(env.actions.length, 0);
    assert.equal(env.api.applyDecision(true).advanced, true);
    assert.deepEqual(env.actions, [['click']]);
});

test('repeated scroll decisions wait 3 seconds after each scroll', () => {
    const env = setup();
    assert.equal(env.api.applyDecision(true).advanced, true);
    const blocked = env.api.applyDecision(true);
    assert.equal(blocked.reason, 'cooldown');
    assert.equal(blocked.retryInMs, 3000);
    env.clock.now += 2999;
    assert.equal(env.api.applyDecision(true).reason, 'cooldown');
    env.clock.now += 1;
    assert.equal(env.api.applyDecision(true).advanced, true);
    assert.equal(env.actions.length, 2);
});

test('a scroll that could not happen does not start the cooldown', () => {
    const env = setup({ videos: false });
    assert.equal(env.api.applyDecision(true).reason, 'no-visible-short');
    env.context.document.querySelectorAll = selector => selector === 'video' ? [env.video] : [];
    env.video.closest = () => null;
    assert.equal(env.api.applyDecision(true).advanced, true, 'next reading scrolls immediately');
});


const settle = () => new Promise(resolve => setImmediate(resolve));

test('adds the hidden engine frame on Shorts while on, and removes it when leaving', async () => {
    const env = setup({ pathname: '/watch' });
    await settle();
    assert.equal(env.frames().length, 0, 'not on regular videos');
    env.context.location.pathname = '/shorts/abc';
    env.tick();
    env.tick();
    assert.equal(env.frames().length, 1, 'exactly one frame');
    const [frame] = env.frames();
    assert.equal(frame.src, 'safari-web-extension://abc123/engine.html#token-1');
    assert.equal(frame.allow, undefined, 'the frame never captures; the page does');
    assert.equal(frame.style.opacity, '0');
    assert.equal(frame.style.pointerEvents, 'none');
    env.context.location.pathname = '/';
    env.tick();
    assert.equal(frame.removed, true, 'leaving Shorts turns the camera off');
});

test('the popup switch turns AutoScroll off and on right away', async () => {
    const env = setup({ stored: { enabled: false } });
    await settle();
    assert.equal(env.frames().length, 0, 'off: no camera or microphone');
    env.listeners.storage({ enabled: { newValue: true } }, 'local');
    assert.equal(env.frames().length, 1);
    const [frame] = env.frames();
    env.listeners.storage({ enabled: { newValue: false } }, 'local');
    assert.equal(frame.removed, true);
    env.listeners.storage({ status: { newValue: {} } }, 'local');
    assert.equal(env.frames().length, 0, 'other settings are ignored');
});

test('re-adds the frame if YouTube removes it from the page', async () => {
    const env = setup();
    await settle();
    const [first] = env.frames();
    first.isConnected = false;
    env.tick();
    assert.equal(env.frames().length, 1);
    assert.notEqual(env.frames()[0], first);
});

test('captures the microphone in the page and streams framed audio to the frame', async () => {
    const env = setup();
    await settle();
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    await settle();
    const [format] = env.sentToFrame();
    assert.deepEqual({ ...format }, { type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: 48000, label: 'MacBook Microphone', token: 'token-1' });
    env.post({ type: 'AUTOSCROLL_MIC_CONFIG', options: { windowSamples: 46800 } });
    assert.equal(env.mic.framer.options.windowSamples, 46800);
    env.mic.node.onaudioprocess({ inputBuffer: { getChannelData: () => [0.25] } });
    const packet = env.sentToFrame().at(-1);
    assert.equal(packet.type, 'AUTOSCROLL_MIC_PACKET');
    assert.equal(packet.packet.rms, 0.25);
    env.context.location.pathname = '/';
    env.tick();
    assert.equal(env.mic.stream.getTracks()[0].stopped, true, 'leaving Shorts stops the microphone');
    assert.equal(env.mic.context.closed, true);
});

test('decisions from the frame scroll the page', async () => {
    const env = setup();
    await settle();
    env.post({ type: 'AUTOSCROLL_DECISION', decision: false });
    assert.equal(env.actions.length, 0);
    env.post({ type: 'AUTOSCROLL_DECISION', decision: true });
    assert.deepEqual(env.actions, [['click']]);
});

test('ignores messages without the frame token', async () => {
    const env = setup();
    await settle();
    env.post({ type: 'AUTOSCROLL_DECISION', decision: true }, { token: 'guess' });
    env.post({ type: 'AUTOSCROLL_DECISION', decision: true }, { token: '' });
    assert.equal(env.actions.length, 0);
});

test('saves the frame status for the popup', async () => {
    const env = setup();
    await settle();
    env.post({ type: 'AUTOSCROLL_STATUS', status: { camera: 'sees your face', microphone: 'listening', lastDecision: 'watch' } });
    await settle();
    assert.equal(env.store.status.camera, 'sees your face');
    assert.equal(env.store.status.at, 10000);
});

test('shows a small pop-up when AutoScroll is ready, then removes it', async () => {
    const env = setup();
    await settle();
    env.post({ type: 'AUTOSCROLL_READY' });
    const toast = env.appended.find(node => node.tag === 'div');
    assert.ok(toast, 'pop-up added');
    const [style, box] = toast.shadow.children;
    assert.match(style.textContent, /position: fixed/);
    assert.equal(box.children[0].textContent, 'AutoScroll is on');
    env.timers.find(timer => timer.ms === 3700).fn();
    assert.equal(toast.removed, true);
});

test('asks for the microphone as soon as the frame is added, even if the frame never loads', async () => {
    const env = setup();
    await settle();
    await settle();
    assert.ok(env.mic.stream, 'microphone requested without waiting for the frame');
    assert.match(env.store.page.microphone, /^on \(MacBook Microphone\)$/);
    assert.equal(env.sentToFrame().length, 0, 'no audio format until the frame is ready');
    env.timers.find(timer => timer.ms === 20000).fn();
    assert.equal(env.store.page.frame, 'did not load');
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    assert.equal(env.store.page.frame, 'loaded');
    assert.equal(env.sentToFrame()[0].type, 'AUTOSCROLL_MIC_FORMAT', 'format sent once the frame is ready');
});

test('reports a blocked microphone to the popup', async () => {
    const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const env = setup({ micError: error });
    await settle();
    await settle();
    assert.equal(env.store.page.microphone, 'blocked: allow the microphone for youtube.com');
});

test('captures the camera in the page after the microphone, and sends frames once the engine is ready', async () => {
    const env = setup();
    for (let i = 0; i < 4; i++) await settle();
    assert.deepEqual(env.requests, ['microphone', 'camera'], 'one site captures both, so Safari mutes neither');
    assert.equal(env.store.page.camera, 'on (FaceTime HD Camera)');
    const sendFrames = env.timers.find(timer => timer.ms === 160);
    await sendFrames.fn();
    assert.equal(env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_CAMERA_FRAME').length, 0, 'not before the engine is ready');
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    await sendFrames.fn();
    await settle();
    const [message] = env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_CAMERA_FRAME');
    assert.equal(message.width, 320);
    assert.equal(message.height, 240, 'downscaled, same aspect ratio');
    assert.equal(message.pixels.byteLength, 320 * 240 * 4, 'raw pixels');
    env.context.location.pathname = '/';
    env.tick();
    assert.equal(env.cam.stream.getTracks()[0].stopped, true, 'leaving Shorts stops the camera');
});

test('a blocked camera leaves the microphone working', async () => {
    const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const env = setup({ cameraError: error });
    for (let i = 0; i < 4; i++) await settle();
    assert.equal(env.store.page.camera, 'blocked: allow the camera for youtube.com');
    assert.match(env.store.page.microphone, /^on /);
});

test('records each scroll attempt for the popup, including why it did not scroll', async () => {
    const env = setup();
    await settle();
    env.post({ type: 'AUTOSCROLL_DECISION', decision: false });
    assert.equal(env.store.page?.scroll, undefined, '"watch" is not recorded');
    env.post({ type: 'AUTOSCROLL_DECISION', decision: true });
    assert.equal(env.store.page.scroll.advanced, true);
    assert.equal(env.store.page.scroll.detail, 'next-button');
    env.post({ type: 'AUTOSCROLL_DECISION', decision: true });
    assert.equal(env.store.page.scroll.advanced, false);
    assert.equal(env.store.page.scroll.detail, 'cooldown');
});

test('drives the engine with a tick every half second once it is ready', async () => {
    const env = setup();
    await settle();
    const ticker = env.timers.find(timer => timer.ms === 250);
    ticker.fn();
    assert.equal(env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_TICK').length, 0, 'not before the engine is ready');
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    ticker.fn();
    assert.equal(env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_TICK').length, 1);
});

test('keeps sending when Safari rewrites the frame address, and notes it', async () => {
    const env = setup();
    await settle();
    const [frame] = env.frames();
    frame.srcAttribute = 'safari-web-extension://per-page-id/engine.html#token-1';
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    env.timers.find(timer => timer.ms === 250).fn();
    assert.ok(env.sentToFrame().some(m => m.type === 'AUTOSCROLL_TICK'), 'messages still go out');
    env.tick();
    assert.equal(env.store.page.link.rewritten, true);
    assert.ok(env.store.page.link.sent > 0);
});

test('repeats the audio format until the engine answers, and reports send errors', async () => {
    const env = setup();
    for (let i = 0; i < 3; i++) await settle();
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    const ticker = env.timers.find(timer => timer.ms === 250);
    ticker.fn();
    ticker.fn();
    assert.equal(env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_MIC_FORMAT').length, 3, 'on ready, then each tick');
    env.post({ type: 'AUTOSCROLL_MIC_CONFIG', options: { windowSamples: 46800 } });
    ticker.fn();
    assert.equal(env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_MIC_FORMAT').length, 3, 'stops once configured');
    env.tick();
    assert.equal(env.store.page.link.sent, 4, "3 formats and 1 tick (ticks wait for replies)");

    const failing = setup({ sendError: Object.assign(new Error('cannot clone'), { name: 'DataCloneError' }) });
    await settle();
    failing.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    failing.timers.find(timer => timer.ms === 250).fn();
    failing.tick();
    assert.equal(failing.store.page.link.error, 'DataCloneError: cannot clone');
});

test('sends the popup face sensitivity to the engine with each tick', async () => {
    const env = setup({ stored: { faceSensitivity: 'high' } });
    await settle();
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    const ticker = env.timers.find(timer => timer.ms === 250);
    ticker.fn();
    assert.equal(env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_TICK').at(-1).faceSensitivity, 'high');
    env.listeners.storage({ faceSensitivity: { newValue: 'low' } }, 'local');
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: false, absentMs: 0 } }); // engine replied
    ticker.fn();
    assert.equal(env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_TICK').at(-1).faceSensitivity, 'low');
    assert.equal(env.frames().length, 1, 'changing sensitivity does not restart the engine');
});

// A presence report: no face looking at the camera since the test's clock mark.
function absent(env) {
    env.absentSince ??= env.clock.now;
    return { known: true, absentMs: env.clock.now - env.absentSince };
}

test('pauses the Short 0.5 s after your face is gone and resumes when you look back', async () => {
    const env = setup();
    await settle();
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    env.clock.now += 499;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    assert.equal(env.video.paused, false, 'a blink or a missed frame is not enough');
    env.clock.now += 1;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    assert.equal(env.video.paused, true);
    assert.equal(env.store.page.paused, true);
    assert.ok(env.appended.some(node => node.shadow?.children[1]?.children[0]?.textContent === 'Paused'), 'a notice explains the pause');
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: true, absentMs: 0 } });
    assert.equal(env.video.paused, false);
    assert.equal(env.video.plays, 1);
    assert.equal(env.store.page.paused, false);
});

test('respects the user: never resumes a video they paused, and does not re-pause after they play', async () => {
    const env = setup();
    await settle();
    env.video.paused = true; // paused by the user
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    env.clock.now += 3000;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: true, absentMs: 0 } });
    assert.equal(env.video.plays, 0, 'their pause stays');

    env.video.paused = false;
    env.absentSince = null;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    env.clock.now += 3000;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    assert.equal(env.video.paused, true);
    env.video.paused = false; // they pressed play while still away
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    assert.equal(env.video.paused, false, 'not paused again during the same absence');
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: true, absentMs: 0 } });
    assert.equal(env.video.plays, 0);
});

test('never pauses without a working camera or with the setting off, and resumes when it is turned off', async () => {
    const env = setup();
    await settle();
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: false, absentMs: 0 } });
    env.clock.now += 5000;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: false, absentMs: 0 } });
    assert.equal(env.video.paused, false, 'no camera: never pauses');
    env.absentSince = null;

    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    env.clock.now += 2000;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    assert.equal(env.video.paused, true);
    env.listeners.storage({ pauseWhenAway: { newValue: false } }, 'local');
    assert.equal(env.video.paused, false, 'turning the setting off resumes');
    env.absentSince = null;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    env.clock.now += 5000;
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(env) });
    assert.equal(env.video.paused, false);

    const off = setup({ stored: { pauseWhenAway: false } });
    await settle();
    off.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(off) });
    off.clock.now += 5000;
    off.post({ type: 'AUTOSCROLL_PRESENCE', presence: absent(off) });
    assert.equal(off.video.paused, false);
});

test('keeps trying to pause while away if no Short is visible yet', async () => {
    const env = setup();
    await settle();
    env.context.document.querySelectorAll = selector => selector === 'video' ? [] : [];
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: true, absentMs: 800 } });
    env.context.document.querySelectorAll = selector => selector === 'video' ? [env.video] : [];
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: true, absentMs: 1000 } });
    assert.equal(env.video.paused, true);
});

test('keeps the microphone on when the engine stops its analysis, and restarts it', async () => {
    const env = setup();
    for (let i = 0; i < 3; i++) await settle();
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    env.post({ type: 'AUTOSCROLL_MIC_CONFIG', options: { windowSamples: 46800 } });
    const formats = () => env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_MIC_FORMAT').length;
    const before = formats();
    env.post({ type: 'AUTOSCROLL_MIC_STOP' });
    assert.equal(env.mic.stream.getTracks()[0].stopped, false, 'microphone stays on');
    env.timers.find(timer => timer.ms === 250).fn();
    assert.equal(formats(), before + 1, 'format re-sent so the engine can restart');
});

test('never lets ticks or camera frames pile up while the engine is busy', async () => {
    const env = setup();
    for (let i = 0; i < 4; i++) await settle();
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    const ticker = env.timers.find(timer => timer.ms === 250);
    const frames = env.timers.find(timer => timer.ms === 160);
    const count = type => env.sentToFrame().filter(m => m.type === type).length;
    for (let i = 0; i < 5; i++) { ticker.fn(); await frames.fn(); }
    assert.equal(count('AUTOSCROLL_TICK'), 1, 'one tick until the engine replies');
    assert.equal(count('AUTOSCROLL_CAMERA_FRAME'), 1, 'one frame until the engine is done with it');
    env.post({ type: 'AUTOSCROLL_PRESENCE', presence: { known: true, absentMs: 0 } });
    env.post({ type: 'AUTOSCROLL_FRAME_DONE' });
    ticker.fn();
    await frames.fn();
    assert.equal(count('AUTOSCROLL_TICK'), 2);
    assert.equal(count('AUTOSCROLL_CAMERA_FRAME'), 2);
    env.clock.now += 2000;
    ticker.fn();
    await frames.fn();
    assert.equal(count('AUTOSCROLL_TICK'), 3, 'a lost reply is given up on after 2 s');
    assert.equal(count('AUTOSCROLL_CAMERA_FRAME'), 3);
});

test('stamps microphone packets with their capture time', async () => {
    const env = setup();
    for (let i = 0; i < 3; i++) await settle();
    env.post({ type: 'AUTOSCROLL_ENGINE_READY' });
    env.post({ type: 'AUTOSCROLL_MIC_CONFIG', options: {} });
    env.mic.node.onaudioprocess({ inputBuffer: { getChannelData: () => [0.1] } });
    const packet = env.sentToFrame().filter(m => m.type === 'AUTOSCROLL_MIC_PACKET').at(-1).packet;
    assert.equal(packet.capturedAt, 10000);
});

// Plays the video to the given time and runs the end-of-video check.
function playTo(env, time) {
    env.video.currentTime = time;
    env.timers.find(timer => timer.ms === 200).fn();
}

test('scrolls to the next Short when the current one reaches its end, once', async () => {
    const env = setup();
    await settle();
    playTo(env, 9.0);
    playTo(env, 9.5);
    assert.equal(env.actions.length, 0, 'not yet');
    playTo(env, 9.7);
    assert.deepEqual(env.actions, [['click']], 'last 0.35 s: next Short');
    assert.equal(env.store.page.scroll.detail, 'video ended');
    playTo(env, 9.9);
    playTo(env, 0.1);
    assert.equal(env.actions.length, 1, 'no second scroll at the loop');
    assert.equal(env.api.applyDecision(true).reason, 'cooldown', 'a reaction right after waits the usual 3 s');
});

test('catches a Short that loops back to the start between checks', async () => {
    const env = setup();
    await settle();
    playTo(env, 9.4);
    playTo(env, 0.2);
    assert.deepEqual(env.actions, [['click']]);
});

test('does not scroll at the end when paused, switched off, or AutoScroll is off', async () => {
    const paused = setup();
    await settle();
    playTo(paused, 9.0);
    paused.video.paused = true;
    playTo(paused, 9.9);
    assert.equal(paused.actions.length, 0, 'paused near the end');

    const off = setup({ stored: { scrollAtEnd: false } });
    await settle();
    playTo(off, 9.0);
    playTo(off, 9.9);
    assert.equal(off.actions.length, 0, 'setting off');
    off.listeners.storage({ scrollAtEnd: { newValue: true } }, 'local');
    playTo(off, 9.0);
    playTo(off, 9.9);
    assert.equal(off.actions.length, 1, 'setting back on');

    const disabled = setup({ stored: { enabled: false } });
    await settle();
    playTo(disabled, 9.0);
    playTo(disabled, 9.9);
    assert.equal(disabled.actions.length, 0, 'AutoScroll off');
});

test('if the scroll fails and the Short loops, it tries again at the next end', async () => {
    const env = setup({ button: false });
    await settle();
    env.container.scrollTop = 1600; // end of feed: next() cannot advance
    playTo(env, 9.0);
    playTo(env, 9.8);
    assert.equal(env.store.page.scroll.detail, 'end-of-feed');
    env.clock.now += 3000;
    env.container.scrollTop = 0;
    playTo(env, 0.2);
    playTo(env, 9.0);
    playTo(env, 9.8);
    assert.deepEqual(env.actions, [['scroll', 800]]);
});
