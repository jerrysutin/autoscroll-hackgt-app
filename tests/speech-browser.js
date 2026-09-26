import { loadSpeechClassifier } from '../AutoScroll/Shared (Extension)/Resources/speech.js';
const output = document.querySelector('#result');
// Fixtures are macOS `say` output: mono 16-bit PCM at 16 kHz.
async function load(name) {
    const view = new DataView(await (await fetch(`fixtures/speech/${name}.wav`)).arrayBuffer());
    for (let offset = 12; offset + 8 <= view.byteLength;) {
        const size = view.getUint32(offset + 4, true);
        if (String.fromCharCode(...[0, 1, 2, 3].map(i => view.getUint8(offset + i))) === 'data') {
            return Float32Array.from({ length: size / 2 }, (_, i) => view.getInt16(offset + 8 + i * 2, true) / 32768);
        }
        offset += 8 + size + size % 2;
    }
    throw new Error(`No audio in ${name}.wav`);
}
document.querySelector('#run').onclick = async () => {
    output.textContent = 'Loading…';
    let classifier;
    try {
        const started = performance.now();
        // ?device=cpu or ?device=gpu forces a backend; the default is automatic.
        const device = new URLSearchParams(location.search).get('device') || 'auto';
        classifier = await loadSpeechClassifier({ device });
        const lines = [`Loaded (${device} → ${classifier.backend}) in ${Math.round(performance.now() - started)} ms.`];
        let failed = false;
        for (const expected of ['positive', 'negative', 'neutral', 'positive', 'negative', 'neutral']) {
            const samples = await load(expected);
            const start = performance.now();
            const result = await classifier.classify(samples);
            failed ||= result.signal !== expected;
            lines.push(`${result.signal === expected ? 'ok' : 'WRONG'} ${expected}: "${result.transcript}" → ${result.signal} (${result.reason}), ` +
                `${Math.round(performance.now() - start)} ms total, transcribe ${result.transcribeMs} ms, sentiment ${result.sentimentMs} ms`);
        }
        output.textContent = `${failed ? 'FAIL' : 'PASS'}\n${lines.join('\n')}`;
    } catch (error) { output.textContent = `FAIL: ${error.message}`; }
    finally { classifier?.dispose(); }
};
