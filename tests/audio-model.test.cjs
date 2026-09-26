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
    const input = tf.zeros([16000]);
    try {
        const baseline = tf.memory().numTensors;
        for (let i = 0; i < 2; i++) {
            const outputs = await model.executeAsync(input);
            try {
                const scores = outputs.find(tensor => tensor.shape.length === 2 && tensor.shape[1] === 521);
                assert.ok(scores, 'Model must expose the expected 521 sound classes');
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
