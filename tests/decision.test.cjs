// Run with: node --experimental-vm-modules --test tests/decision.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const decisionPath = path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources/decision.js');

// decision.js with stand-ins for the camera classifier and the audio detector.
async function setup() {
    const env = { now: 1000, scores: null, label: 'neutral', starts: [], stops: 0 };
    const context = vm.createContext({ Date: class extends Date { static now() { return env.now; } }, console });
    const stubs = {
        './facialExpressionClassifier.js': new vm.SyntheticModule(['emotionProbabilities', 'getFacePresence', 'getScores', 'pushFrame', 'startCamera', 'stopCamera'], function () {
            this.setExport('getFacePresence', () => env.presence || 'unknown');
            this.setExport('pushFrame', frame => { env.frame = frame; });
            this.setExport('getScores', () => env.scores);
            // Probabilities: env.probabilities if set, else all on env.label.
            this.setExport('emotionProbabilities', () => env.probabilities || { [env.label]: 1 });
            this.setExport('startCamera', options => { env.camera = options?.external ? 'external' : 'on'; });
            this.setExport('stopCamera', () => { env.camera = 'off'; });
        }, { context }),
        './audio.js': new vm.SyntheticModule(['createAudioDetector'], function () {
            this.setExport('createAudioDetector', callbacks => {
                env.hear = signal => callbacks.onSignal(signal, { source: 'words' });
                env.speech = status => callbacks.onSpeech(status);
                return { start: options => { env.starts.push(options); return Promise.resolve(true); }, stop: () => { env.stops++; } };
            });
        }, { context })
    };
    const module = new vm.SourceTextModule(fs.readFileSync(decisionPath, 'utf8'), { context, identifier: decisionPath });
    await module.link(specifier => stubs[specifier]);
    await module.evaluate();
    return { env, ...module.namespace };
}

test('without audio, a negative face scrolls once it lasts about half a second', async () => {
    const { env, decide } = await setup();
    assert.equal(decide(), null, 'no face reading yet');
    env.scores = [1];
    env.label = 'anger';
    assert.equal(decide(), false, 'one frame is not enough');
    env.now += 500;
    assert.equal(decide(), true);
    env.label = 'happiness';
    env.now += 500;
    decide();
    env.now += 500;
    assert.equal(decide(), false);
});

test('a mild frown scrolls at medium sensitivity (15%): negative emotions are added up', async () => {
    const { env, decide, setFaceSensitivity, getFaceInfo } = await setup();
    env.scores = [1];
    // "neutral" is the top label, but 20% of the face reads as negative.
    env.probabilities = { neutral: 0.75, sadness: 0.1, anger: 0.06, contempt: 0.04, happiness: 0.05 };
    decide();
    env.now += 500;
    assert.equal(decide(), true);
    assert.ok(Math.abs(getFaceInfo().negative - 0.2) < 1e-9);
    assert.equal(getFaceInfo().threshold, 0.15);

    setFaceSensitivity('low');
    env.now += 500;
    decide();
    env.now += 500;
    assert.equal(decide(), false, 'low (25%) needs a stronger reaction');
    assert.equal(getFaceInfo().threshold, 0.25);
    setFaceSensitivity('high');
    assert.equal(getFaceInfo().threshold, 0.1);
    setFaceSensitivity('nonsense');
    assert.equal(getFaceInfo().sensitivity, 'high', 'unknown values are ignored');
});

test('the face needs more negative than positive, and one reading does not trigger twice', async () => {
    const { env, decide } = await setup();
    env.scores = [1];
    env.probabilities = { happiness: 0.5, sadness: 0.4, neutral: 0.1 };
    decide();
    env.now += 500;
    assert.equal(decide(), false, 'smiling more than frowning keeps watching');
    env.probabilities = { anger: 0.9, neutral: 0.1 };
    env.now += 2000;
    decide();
    env.now += 500;
    assert.equal(decide(), true);
    env.now += 500;
    assert.equal(decide(), false, 'history restarts after a scroll');
});

test('a single odd frame among neutral ones does not scroll', async () => {
    const { env, decide } = await setup();
    env.scores = [1];
    env.probabilities = { neutral: 1 };
    decide();
    env.now += 500;
    decide();
    env.probabilities = { disgust: 0.3, neutral: 0.7 };
    env.now += 500;
    assert.equal(decide(), false, 'averaged with the neutral frames: 10%');
});

test('an audio reaction overrides the face', async () => {
    const { env, decide } = await setup();
    env.scores = [1];
    env.label = 'happiness';
    env.hear('negative');
    assert.equal(decide(), true, '"skip this" scrolls even while smiling');
    env.label = 'disgust';
    env.hear('positive');
    assert.equal(decide(), false, 'a laugh keeps watching even with a negative face');
});

test('an audio reaction decides once, then the face takes over', async () => {
    const { env, decide } = await setup();
    env.scores = [1];
    env.label = 'happiness';
    env.hear('negative');
    assert.equal(decide(), true);
    assert.equal(decide(), false, 'one "skip" cannot cause a second scroll');
});

test('an audio reaction older than 3 seconds is ignored', async () => {
    const { env, decide } = await setup();
    env.hear('negative');
    env.now += 3001;
    assert.equal(decide(), null);
});

test('startAudio and stopAudio control the microphone and clear old reactions', async () => {
    const { env, decide, startAudio, stopAudio } = await setup();
    assert.equal(await startAudio({ deviceId: 'mic' }), true);
    assert.equal(env.starts[0].deviceId, 'mic');
    env.hear('negative');
    stopAudio();
    assert.equal(env.stops, 1);
    assert.equal(decide(), null, 'a reaction from before stop does not count');
});

test('re-exports camera controls for the AutoScroll button', async () => {
    const { env, startCamera, stopCamera } = await setup();
    startCamera();
    assert.equal(env.camera, 'on');
    stopCamera();
    assert.equal(env.camera, 'off');
});

test('remembers speech-model state and the last phrase heard, for the popup', async () => {
    const { env, getSpeechInfo } = await setup();
    assert.equal(getSpeechInfo().models, 'off');
    env.speech({ status: 'listening', backend: 'gpu' });
    assert.equal(getSpeechInfo().models, 'ready (GPU)');
    env.speech({ status: 'transcribing' });
    assert.equal(getSpeechInfo().models, 'ready (GPU)', 'per-phrase states do not replace it');
    env.speech({ status: 'result', transcript: 'this is so boring', signal: 'negative' });
    assert.equal(getSpeechInfo().heard.text, 'this is so boring');
    assert.equal(getSpeechInfo().heard.late, false);
    env.speech({ status: 'late', transcript: 'skip', signal: 'negative' });
    assert.equal(getSpeechInfo().heard.late, true);
    env.speech({ status: 'unavailable', message: 'assets missing' });
    assert.equal(getSpeechInfo().models, 'unavailable: assets missing');
});
