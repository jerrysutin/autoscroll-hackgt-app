// Local speech-to-text (Whisper tiny.en) and text sentiment (Twitter RoBERTa).
// Shared by the GPU path (page thread) and the CPU path (speech-worker.js).
// All model and runtime files are bundled; nothing is downloaded.
import { env, pipeline } from './speech-assets/transformers.min.js';
import { describeStatement } from './speech-core.js';

// Whisper's encoder always processes 30 s of padded audio, which dominates the
// delay. On the GPU it runs in full precision (the GPU backend handles 8-bit
// weights poorly); the short text decoder stays on the CPU either way.
const WHISPER = {
    gpu: { device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    cpu: { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } }
};

function configure() {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    // A same-origin path, not a full URL: Transformers.js skips its local
    // file-existence check for http(s) URLs and would miss the tokenizer.
    env.localModelPath = new URL('./speech-assets/models/', import.meta.url).pathname;
    env.backends.onnx.wasm.wasmPaths = new URL('./speech-assets/', import.meta.url).href;
    // Extension pages are not cross-origin isolated, so threads are unavailable.
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
}

// On music, singing, or repeated sounds Whisper can loop ("la la la ...") until
// its 448-token limit: hundreds of words and seconds of work, during which new
// phrases wait and expire. A phrase this short cannot hold more than about
// 8 tokens a second, and no 3-token run needs to repeat.
function transcribeOptions(seconds) {
  return { max_new_tokens: Math.min(48, Math.ceil(seconds * 8) + 6), no_repeat_ngram_size: 3 };
}

// backend: 'gpu' or 'cpu'. A GPU load that fails (including its warm-up) throws.
export async function createSpeechModels(backend) {
    configure();
    // The sentiment model takes about 70 ms on the CPU, so it always stays there.
    const [transcribe, sentiment] = await Promise.all([
        pipeline('automatic-speech-recognition', 'whisper-tiny.en', WHISPER[backend]),
        // Weights are split into three chunks (<50 MB each) so they fit in git.
        pipeline('text-classification', 'twitter-roberta-base-sentiment-latest', { device: 'wasm', dtype: 'q8', use_external_data_format: 3 })
    ]);
    const models = {
        backend,
        async analyze(samples) {
            const started = performance.now();
            const { text } = await transcribe(samples, transcribeOptions(samples.length / 16000));
            const transcribed = performance.now();
            let scores = null;
            if (describeStatement(text, { neutral: 1 }).reason !== 'no-words') {
                const ranked = await sentiment(text.trim(), { top_k: 3 });
                scores = Object.fromEntries(ranked.map(item => [item.label.toLowerCase(), item.score]));
            }
            return { ...describeStatement(text, scores), rawTranscript: text, backend,
                transcribeMs: Math.round(transcribed - started), sentimentMs: Math.round(performance.now() - transcribed) };
        },
        dispose: () => Promise.allSettled([transcribe.dispose(), sentiment.dispose()])
    };
    try {
        // Compile GPU shaders and warm caches now, not during the first phrase.
        await transcribe(new Float32Array(16000));
    } catch (error) {
        await models.dispose();
        throw error;
    }
    return models;
}
