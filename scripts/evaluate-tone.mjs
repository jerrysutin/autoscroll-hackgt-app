// Explicit, local-model diagnostic evaluation. No microphone recordings are used.
// Run `node scripts/evaluate-tone.mjs --help` for opt-in fixture downloads.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeToneSamples, describeTone } from '../AutoScroll/Shared (Extension)/Resources/tone-core.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
    console.log(`Usage: node scripts/evaluate-tone.mjs [--download] [--variants full,trim,pad3,crop1,crop075] [--limit N]

Downloads are opt-in. Public CREMA-D clips and results stay in the OS temporary
folder, under autoscroll-tone-eval. Existing clips must match pinned SHA-256s.
Default variants: full,trim. Crops/padding diagnose context and silence effects.
Uses the app's bundled ONNX model, preprocessing, and current confidence gate.
CREMA-D was a training source: results are diagnostic, not independent accuracy.`);
    process.exit(0);
}
const variants = ['full', 'trim'];
let download = false;
let limit = Infinity;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--download') download = true;
    else if (args[i] === '--variants') {
        variants.splice(0, variants.length, ...(args[++i] || '').split(','));
        if (!variants.length || variants.some(value => !['full', 'trim', 'pad3', 'crop1', 'crop075'].includes(value))) {
            throw new Error('Unknown variant. Use full,trim,pad3,crop1,crop075.');
        }
    } else if (args[i] === '--limit') {
        limit = Number(args[++i]);
        if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer.');
    } else throw new Error(`Unknown argument: ${args[i]}. Use --help.`);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestURL = new URL('../tests/fixtures/tone-eval.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestURL, 'utf8'));
const assetURL = new URL('../AutoScroll/Shared (Extension)/Resources/tone-assets/', import.meta.url);
const cache = path.join(tmpdir(), 'autoscroll-tone-eval');
await mkdir(cache, { recursive: true });

// The pinned fixtures are mono, 16-bit PCM at 16 kHz. Reject incompatible input
// instead of silently changing channels/sample rate or misreading WAV metadata.
function decodeWav(bytes) {
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Expected a RIFF/WAVE file.');
    }
    let format;
    let data;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + size > bytes.length) throw new Error('Truncated WAV chunk.');
        if (type === 'fmt ' && size >= 16) {
            format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
                rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
        } else if (type === 'data') data = bytes.subarray(start, start + size);
        offset = start + size + size % 2;
    }
    if (format?.encoding !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16 || !data?.length || data.length % 2) {
        throw new Error(`Expected nonempty mono 16-bit PCM at 16 kHz; received ${JSON.stringify(format)}.`);
    }
    return Float32Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2) / 32768);
}

// Energy trimming is an evaluation transformation, not a second speech detector.
// Retain 100 ms of context on either side of the audible part of each fixture.
function trimEdges(samples) {
    const frame = 320;
    const energy = [];
    for (let start = 0; start < samples.length; start += frame) {
        let sum = 0;
        for (let i = start; i < Math.min(start + frame, samples.length); i++) sum += samples[i] ** 2;
        energy.push(Math.sqrt(sum / frame));
    }
    const threshold = Math.max(0.003, Math.max(...energy) * 0.08);
    const first = energy.findIndex(value => value > threshold);
    const last = energy.findLastIndex(value => value > threshold);
    if (first < 0) throw new Error('Fixture contains no audible speech.');
    return samples.slice(Math.max(0, first * frame - 1600), Math.min(samples.length, (last + 1) * frame + 1600));
}

function loudestCrop(samples, length) {
    if (samples.length <= length) return samples;
    let peak = -1;
    let offset = 0;
    for (let start = 0; start + length <= samples.length; start += 320) {
        let sum = 0;
        for (let i = start; i < start + length; i++) sum += samples[i] ** 2;
        if (sum > peak) { peak = sum; offset = start; }
    }
    return samples.slice(offset, offset + length);
}

const fixtures = [];
for (const fixture of manifest.fixtures.slice(0, limit)) {
    const filename = path.join(cache, fixture.file);
    let bytes;
    try { bytes = await readFile(filename); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!download) throw new Error(`Missing fixture ${fixture.file}. Rerun with --download to fetch public audio into ${cache}.`);
        const response = await fetch(fixture.url);
        if (!response.ok) throw new Error(`Download failed (${response.status}): ${fixture.file}`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (sha256(bytes) !== fixture.sha256) throw new Error(`Download checksum mismatch: ${fixture.file}`);
        await writeFile(filename, bytes);
    }
    if (sha256(bytes) !== fixture.sha256) throw new Error(`Cached fixture checksum mismatch: ${filename}`);
    fixtures.push({ ...fixture, samples: decodeWav(bytes) });
}

const ort = await import(new URL('ort.wasm.min.mjs', assetURL));
ort.env.wasm.wasmPaths = fileURLToPath(assetURL);
ort.env.wasm.numThreads = 1;
const model = await readFile(new URL('model.onnx', assetURL));
const config = JSON.parse(await readFile(new URL('config.json', assetURL)));
const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
const results = [];
try {
    console.log(`Diagnostic fixture set: ${manifest.dataset}, source ${manifest.revision}`);
    console.log(manifest.limitations[0]);
    for (const fixture of fixtures) {
        const trimmed = trimEdges(fixture.samples);
        for (const variant of variants) {
            let samples = variant === 'full' ? fixture.samples : trimmed;
            if (variant === 'pad3') {
                const padded = new Float32Array(Math.max(48000, trimmed.length));
                padded.set(trimmed, Math.floor((padded.length - trimmed.length) / 2));
                samples = padded;
            } else if (variant === 'crop1') samples = loudestCrop(trimmed, 16000);
            else if (variant === 'crop075') samples = loudestCrop(trimmed, 12000);
            const input = new ort.Tensor('float32', normalizeToneSamples(samples), [1, samples.length]);
            let outputs;
            try {
                const start = performance.now();
                outputs = await session.run({ input_values: input });
                const result = describeTone(outputs.logits.data, config.id2label);
                results.push({ file: fixture.file, expectedEmotion: fixture.expectedEmotion, expectedSignal: fixture.expectedSignal,
                    variant, seconds: samples.length / 16000, inferenceMs: Math.round(performance.now() - start), ...result });
                console.log(`${fixture.file} ${variant}: expected ${fixture.expectedSignal}, predicted ${result.signal}; ${result.emotion} ${result.score.toFixed(3)}, lead ${result.lead.toFixed(3)}`);
            } finally {
                input.dispose();
                if (outputs) Object.values(outputs).forEach(tensor => tensor.dispose());
            }
        }
    }
} finally { await session.release(); }

const summary = variants.map(variant => {
    const rows = results.filter(row => row.variant === variant);
    const confusion = {};
    for (const row of rows) {
        const pair = `${row.expectedSignal} -> ${row.signal}`;
        confusion[pair] = (confusion[pair] || 0) + 1;
    }
    return { variant, correctSignals: rows.filter(row => row.signal === row.expectedSignal).length, count: rows.length, confusion };
});
const resultPath = path.join(cache, 'evaluation-results.json');
await writeFile(resultPath, JSON.stringify({
    createdAt: new Date().toISOString(), sourceRevision: manifest.revision, limitations: manifest.limitations,
    modelSha256: sha256(model), coreSha256: sha256(await readFile(new URL('../AutoScroll/Shared (Extension)/Resources/tone-core.js', import.meta.url))),
    summary, results
}, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
console.log(`Detailed results: ${resultPath}`);
