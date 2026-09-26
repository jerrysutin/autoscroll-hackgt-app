const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const assets = path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources/audio-assets');

test('bundled model, runtime, labels and licenses match source checksums', () => {
    const sources = JSON.parse(fs.readFileSync(path.join(assets, 'SOURCES.json')));
    assert.ok(sources.runtime.url.endsWith('/tf.es2017.min.js'));
    for (const [file, checksum] of Object.entries(sources.files)) {
        assert.equal(createHash('sha256').update(fs.readFileSync(path.join(assets, file))).digest('hex'), checksum, file);
    }
});

test('real pretrained YAMNet produces finite sound scores without leaking tensors', async () => {
    const tf = require(path.join(assets, 'tf.min.js'));
    await tf.setBackend('cpu');
    const directory = path.join(assets, 'yamnet');
    const json = JSON.parse(fs.readFileSync(path.join(directory, 'model.json')));
    const weights = Buffer.concat(json.weightsManifest.flatMap(group => group.paths.map(file => fs.readFileSync(path.join(directory, file)))));
    const model = await tf.loadGraphModel(tf.io.fromMemory({
        modelTopology: json.modelTopology,
        signature: json.signature,
        weightSpecs: json.weightsManifest.flatMap(group => group.weights),
        weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength)
    }));
    const input = tf.zeros([15600]);
    try {
        const baseline = tf.memory().numTensors;
        for (let i = 0; i < 2; i++) {
            const outputs = await model.executeAsync(input);
            try {
                const scores = outputs.find(tensor => tensor.shape.length === 2 && tensor.shape[1] === 521);
                assert.ok(scores, 'Model must expose the expected 521 sound classes');
                assert.deepEqual(scores.shape, [1, 521], 'Capture duration must produce one complete patch without an extra padded patch');
                const values = await scores.data();
                assert.ok(values.every(Number.isFinite));
                assert.ok(values[494] > 0.9, 'Silence should be recognized on zero PCM');
            } finally {
                tf.dispose(outputs);
            }
            assert.equal(tf.memory().numTensors, baseline);
        }
    } finally {
        input.dispose();
        model.dispose();
    }
});


test('reaction scores suppress isolated spikes, accumulate consistent laughter and reset', async () => {
    const vm = require('node:vm');
    const { pathToFileURL } = require('node:url');
    const tf = require(path.join(assets, 'tf.min.js'));
    await tf.setBackend('cpu');
    const first = new Array(521).fill(0);
    first[13] = 0.6;
    let disposed = false;
    const fakeModel = {
        executeAsync: async () => [tf.tensor2d([first])],
        dispose: () => { disposed = true; }
    };
    const modulePath = path.join(assets, '../audio.js');
    const context = vm.createContext({
        tf: { ...tf, loadGraphModel: async () => fakeModel }, URL,
        fetch: async () => ({ ok: true, text: async () => fs.readFileSync(path.join(assets, 'yamnet/yamnet_class_map.csv'), 'utf8') })
    });
    const module = new vm.SourceTextModule(fs.readFileSync(modulePath, 'utf8') + '\nexport { loadYamnet };', {
        context, initializeImportMeta(meta) { meta.url = pathToFileURL(modulePath).href; }
    });
    await module.link(() => { throw new Error('Unexpected import'); });
    await module.evaluate();
    const classifier = await module.namespace.loadYamnet();
    const baseline = tf.memory().numTensors;
    const waveform = new Float32Array(15600);
    const conservative = { threshold: 0.35, margin: 0.15 };
    assert.equal(await classifier.classify(waveform, conservative), 'neutral', 'one moderate spike should not immediately trigger');
    assert.ok(Math.abs(classifier.getDiagnostics().positive - 0.3) < 1e-6);
    assert.ok(Math.abs(classifier.getDiagnostics().rawPositive - 0.6) < 1e-6);
    first[13] = 0;
    assert.equal(await classifier.classify(waveform, conservative), 'neutral');
    assert.ok(Math.abs(classifier.getDiagnostics().positive - 0.15) < 1e-6);
    first[15] = 0.6;
    assert.equal(await classifier.classify(waveform, conservative), 'positive', 'consistent evidence survives a switch to giggling');
    first[15] = 0;
    first[13] = 0.6;
    assert.equal(await classifier.classify(waveform, conservative), 'positive');
    assert.equal(classifier.getDiagnostics().topSound, 'Laughter');
    assert.equal(classifier.getDiagnostics().reason, 'reaction');
    assert.ok(classifier.getDiagnostics().positive > 0.48);
    classifier.reset();
    assert.equal(classifier.getDiagnostics(), null);
    assert.equal(await classifier.classify(waveform, conservative), 'neutral');
    classifier.reset();
    assert.equal(await classifier.classify(waveform), 'positive', 'default sensitivity accepts weaker smoothed laughter');
    assert.equal(tf.memory().numTensors, baseline);
    classifier.dispose();
    assert.equal(disposed, true);
});
