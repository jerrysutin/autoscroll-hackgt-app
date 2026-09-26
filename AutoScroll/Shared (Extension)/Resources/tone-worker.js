import * as ort from './tone-assets/ort.wasm.min.mjs';
import { normalizeToneSamples, describeTone } from './tone-core.js';

let session;
let labels;
self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'load') {
            ort.env.wasm.wasmPaths = new URL('./tone-assets/', import.meta.url).href;
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.proxy = false;
            const response = await fetch(new URL('./tone-assets/config.json', import.meta.url));
            if (!response.ok) throw new Error('Tone model configuration is missing.');
            labels = (await response.json()).id2label;
            session = await ort.InferenceSession.create(new URL('./tone-assets/model.onnx', import.meta.url).href, {
                executionProviders: ['wasm'], graphOptimizationLevel: 'all'
            });
            self.postMessage({ type: 'ready' });
        } else if (data.type === 'classify') {
            const samples = normalizeToneSamples(data.samples);
            const input = new ort.Tensor('float32', samples, [1, samples.length]);
            let outputs;
            try {
                outputs = await session.run({ input_values: input });
                self.postMessage({ type: 'result', result: describeTone(outputs.logits.data, labels) });
            } finally {
                input.dispose();
                if (outputs) Object.values(outputs).forEach(tensor => tensor.dispose());
            }
        }
    } catch (error) {
        self.postMessage({ type: 'error', message: error.message || 'Tone analysis failed.' });
    }
};
