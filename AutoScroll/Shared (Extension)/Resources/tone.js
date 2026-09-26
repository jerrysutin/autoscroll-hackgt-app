// Keep the heavier tone model off the capture/UI thread. No runtime network assets.
export function loadToneClassifier({ signal } = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./tone-worker.js', import.meta.url), { type: 'module' });
        let pending = null;
        let disposed = false;
        let timer = setTimeout(() => fail(new Error('Tone model loading timed out.')), 60000);
        function fail(error) {
            clearTimeout(timer);
            worker.terminate();
            disposed = true;
            reject(error);
            pending?.reject(error);
            pending = null;
        }
        if (signal?.aborted) { fail(new Error('Tone classifier stopped.')); return; }
        signal?.addEventListener('abort', () => fail(new Error('Tone classifier stopped.')), { once: true });
        worker.onerror = () => fail(new Error('Tone worker failed. Check the bundled tone assets and WebAssembly support.'));
        worker.onmessage = ({ data }) => {
            if (disposed) return;
            if (data.type === 'error') { fail(new Error(data.message)); return; }
            clearTimeout(timer);
            if (data.type === 'ready') {
                resolve({
                    classify(samples) {
                        if (disposed) return Promise.reject(new Error('Tone classifier is closed.'));
                        if (pending) return Promise.reject(new Error('Tone classifier is busy.'));
                        return new Promise((yes, no) => {
                            pending = { resolve: yes, reject: no };
                            timer = setTimeout(() => fail(new Error('Tone inference timed out.')), 15000);
                            worker.postMessage({ type: 'classify', samples }, [samples.buffer]);
                        });
                    },
                    dispose() { fail(new Error('Tone classifier stopped.')); }
                });
            } else if (data.type === 'result') {
                pending?.resolve(data.result);
                pending = null;
            }
        };
        worker.postMessage({ type: 'load' });
    });
}
