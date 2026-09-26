import { createAudioDetector } from './audio.js';

const output = document.querySelector('#signal');
const status = document.querySelector('#status');
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const messages = {
    idle: 'Microphone is off.',
    starting: 'Allow microphone access. Loading the local sound model…',
    listening: 'Listening for vocal reactions…',
    error: 'Audio detection stopped.'
};
const audio = createAudioDetector({
    onSignal(signal) {
        output.textContent = signal;
        output.dataset.signal = signal;
    },
    onStateChange(state) {
        status.textContent = messages[state];
        start.disabled = state === 'starting' || state === 'listening';
        stop.disabled = !start.disabled;
    },
    onError(error) { status.textContent = error.message; }
});
start.addEventListener('click', () => { audio.start().catch(() => {}); });
stop.addEventListener('click', () => { audio.stop(); });
window.addEventListener('pagehide', () => { audio.stop(); });
