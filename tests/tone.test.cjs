const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const root = path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources');
const assets = path.join(root, 'tone-assets');
const core = import(`data:text/javascript;base64,${fs.readFileSync(path.join(root, 'tone-core.js')).toString('base64')}`);

test('tone maps happy and negative emotions but leaves calm, surprise, and ties neutral', async () => {
    const { describeTone, normalizeToneSamples } = await core;
    const labels = JSON.parse(fs.readFileSync(path.join(assets, 'config.json'))).id2label;
    for (const [index, expected] of ['negative', 'neutral', 'negative', 'negative', 'positive', 'negative', 'neutral'].entries()) {
        const logits = new Float32Array(7);
        logits[index] = 6;
        assert.equal(describeTone(logits, labels).signal, expected);
    }
    assert.equal(describeTone(new Float32Array(7), labels).signal, 'neutral');
    assert.throws(() => describeTone(new Float32Array([NaN]), labels), /Invalid/);
    const input = new Float32Array([1, 2, 3, 4]);
    const normalized = normalizeToneSamples(input);
    assert.ok(Math.abs(normalized.reduce((a, b) => a + b, 0)) < 1e-6);
    assert.deepEqual(Array.from(input), [1, 2, 3, 4]);
    assert.ok(normalizeToneSamples(new Float32Array(10)).every(Number.isFinite));
});

test('bundled tone assets match pinned hashes', () => {
    const sources = JSON.parse(fs.readFileSync(path.join(assets, 'SOURCES.json')));
    for (const [file, info] of Object.entries(sources.files)) {
        assert.equal(createHash('sha256').update(fs.readFileSync(path.join(assets, file))).digest('hex'), info.sha256, file);
    }
});

test('real bundled tone model runs a three-second 16 kHz window with finite emotion scores', async () => {
    const ort = await import(pathToFileURL(path.join(assets, 'ort.wasm.min.mjs')));
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = pathToFileURL(assets + path.sep).href;
    const session = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(assets, 'model.onnx'))));
    const input = new ort.Tensor('float32', new Float32Array(48000), [1, 48000]);
    let output;
    try {
        assert.deepEqual(session.inputNames, ['input_values']);
        output = await session.run({ input_values: input });
        assert.equal(output.logits.data.length, 7);
        assert.ok(output.logits.data.every(Number.isFinite));
    } finally {
        input.dispose();
        if (output) Object.values(output).forEach(tensor => tensor.dispose());
        await session.release();
    }
});


test('negative tone adds up its emotion family instead of requiring one emotion to win', async () => {
    const { describeTone } = await core;
    const labels = JSON.parse(fs.readFileSync(path.join(assets, 'config.json'))).id2label;
    // angry, calm, disgust, fearful, happy, sad, surprised
    const classify = scores => describeTone(scores.map(Math.log), labels);
    const split = classify([0.3, 0.1, 0.25, 0.05, 0.02, 0.26, 0.02]);
    assert.equal(split.emotion, 'angry');
    assert.equal(split.signal, 'negative', 'mixed angry/disgust/sad is clearly negative');
    assert.ok(Math.abs(split.polarity.negative - 0.86) < 1e-9);
    const weak = classify([0.25, 0.35, 0.1, 0.05, 0.1, 0.1, 0.05]);
    assert.equal(weak.signal, 'neutral', 'a 0.5 negative total without a clear lead stays neutral');
    assert.equal(weak.reason, 'uncertain');
    assert.equal(classify([0.02, 0.8, 0.02, 0.02, 0.1, 0.02, 0.02]).reason, 'neutral-emotion');
});

test('positive tone keeps its 0.55 score and 0.15 lead over every other family', async () => {
    const { describeTone } = await core;
    const labels = JSON.parse(fs.readFileSync(path.join(assets, 'config.json'))).id2label;
    const classify = scores => describeTone(scores.map(Math.log), labels);
    assert.equal(classify([0.03, 0.25, 0.03, 0.03, 0.6, 0.03, 0.03]).signal, 'positive');
    assert.equal(classify([0.03, 0.38, 0.03, 0.03, 0.47, 0.03, 0.03]).signal, 'neutral');
    assert.equal(classify([0.12, 0.04, 0.12, 0.1, 0.5, 0.08, 0.04]).signal, 'neutral', 'a 0.42 negative total blocks a narrow happy lead');
});
