import { loadToneClassifier } from '../AutoScroll/Shared (Extension)/Resources/tone.js';
const output = document.querySelector('#result');
document.querySelector('#run').onclick = async () => {
    output.textContent = 'Loading…';
    let classifier;
    try {
        classifier = await loadToneClassifier();
        const start = performance.now();
        const result = await classifier.classify(new Float32Array(48000));
        if (result.scores.length !== 7 || !result.scores.every(item => Number.isFinite(item.score))) throw new Error('Invalid scores');
        output.textContent = `PASS: seven finite scores, ${Math.round(performance.now() - start)} ms.\n${JSON.stringify(result, null, 2)}`;
    } catch (error) { output.textContent = `FAIL: ${error.message}`; }
    finally { classifier?.dispose(); }
};
