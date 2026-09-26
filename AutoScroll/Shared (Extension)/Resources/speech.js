// Speech analysis for audio.js. One phrase is analyzed at a time.
// device: 'auto' (GPU when it works, else CPU), 'gpu' (fail without it), or 'cpu'.
//
// GPU: Whisper's encoder runs on the Mac's GPU, about 3x faster (0.45 s vs 1.55 s
// per phrase in WebKit). It runs on the page thread, because terminating a worker
// that used WebGPU crashes the page in WebKit, including when the tab closes or
// navigates. The models load once per page and are reused by the next start().
// CPU: the models run in speech-worker.js, which is terminated on stop.
let shared = null;
let nextId = 1;
let gpuModels = null;

function createWorker() {
    const worker = new Worker(new URL('./speech-worker.js', import.meta.url), { type: 'module' });
    const replies = new Map();
    // Requests run one at a time, so a phrase from a stopped session only delays
    // the next session's first phrase instead of failing it.
    const entry = { worker, backend: null, broken: false, queue: Promise.resolve() };
    function request(message, transfer = [], timeout) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                replies.delete(id);
                breakWorker(new Error(message.type === 'load' ? 'Speech models took too long to load.' : 'Speech analysis timed out.'));
            }, timeout);
            replies.set(id, { resolve, reject, timer });
            worker.postMessage({ ...message, id }, transfer);
        });
    }
    // A failed or hung worker cannot be reused; ending it is the only option.
    function breakWorker(error) {
        entry.broken = true;
        if (shared === entry) shared = null;
        worker.terminate();
        for (const reply of replies.values()) { clearTimeout(reply.timer); reply.reject(error); }
        replies.clear();
    }
    worker.onerror = () => breakWorker(new Error('Speech worker failed. Check the bundled speech assets and WebAssembly support.'));
    worker.onmessage = ({ data }) => {
        const reply = replies.get(data.id);
        if (!reply) return;
        replies.delete(data.id);
        clearTimeout(reply.timer);
        if (data.type === 'error') reply.reject(new Error(data.message));
        else reply.resolve(data);
    };
    entry.request = request;
    entry.close = () => breakWorker(new Error('Speech analysis stopped.'));
    entry.ready = request({ type: 'load' }, [], 90000).then(({ backend }) => {
        entry.backend = backend;
        return entry;
    }, error => { breakWorker(error); throw error; });
    return entry;
}

async function hasGpu() {
    try { return Boolean(await globalThis.navigator?.gpu?.requestAdapter()); } catch { return false; }
}

function abortable(promise, signal) {
    if (!signal) return promise;
    return Promise.race([promise, new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Speech analysis stopped.')), { once: true }))]);
}

// Serializes requests so a phrase from a stopped session only delays the next
// session's first phrase instead of failing it.
function handle(backend, queueOwner, run, close = () => {}) {
    let open = true;
    return {
        backend,
        classify(samples) {
            if (!open) return Promise.reject(new Error('Speech analysis is closed.'));
            const result = queueOwner.queue.then(() => run(samples));
            queueOwner.queue = result.catch(() => {});
            return result;
        },
        dispose() {
            if (!open) return;
            open = false;
            close();
        }
    };
}

async function loadGpu(signal) {
    // An abort only detaches this caller; loading continues for the next start().
    gpuModels ||= import('./speech-models.js')
        .then(({ createSpeechModels }) => createSpeechModels('gpu'))
        .then(models => Object.assign(models, { queue: Promise.resolve() }))
        .catch(error => { gpuModels = null; throw error; });
    const models = await abortable(gpuModels, signal);
    return handle('gpu', models, samples => models.analyze(samples));
}

async function loadCpu(signal) {
    if (!shared || shared.broken) shared = createWorker();
    const entry = shared;
    await abortable(entry.ready, signal);
    return handle('cpu', entry,
        samples => entry.request({ type: 'analyze', samples }, [samples.buffer], 15000).then(({ result }) => result),
        () => entry.close());
}

export async function loadSpeechClassifier({ signal, device = 'auto' } = {}) {
    if (signal?.aborted) throw new Error('Speech analysis stopped.');
    if (device !== 'cpu') {
        if (await hasGpu()) {
            try {
                return await loadGpu(signal);
            } catch (error) {
                if (device === 'gpu' || signal?.aborted) throw error;
                console.warn('Speech GPU mode failed; using the CPU.', error);
            }
        } else if (device === 'gpu') {
            throw new Error('WebGPU is not available in this browser.');
        }
    }
    return loadCpu(signal);
}
