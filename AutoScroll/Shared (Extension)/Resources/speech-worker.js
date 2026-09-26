// CPU speech analysis off the capture/UI thread. The GPU path runs on the page
// thread instead (see speech.js). Replies carry the request id.
import { createSpeechModels } from './speech-models.js';

let models;
self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'load') {
            models = await createSpeechModels('cpu');
            self.postMessage({ type: 'ready', id: data.id, backend: models.backend });
        } else if (data.type === 'analyze') {
            self.postMessage({ type: 'result', id: data.id, result: await models.analyze(data.samples) });
        }
    } catch (error) {
        self.postMessage({ type: 'error', id: data.id, message: error.message || 'Speech analysis failed.' });
    }
};
