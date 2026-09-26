import { createAudioDetector } from './audio.js';

const output = document.querySelector('#signal');
const status = document.querySelector('#status');
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const level = document.querySelector('#input-level');
const mic = document.querySelector('#microphone');
const detected = document.querySelector('#detected-sound');
const scores = document.querySelector('#reaction-scores');
const speechStatus = document.querySelector('#speech-status');
const modelLevel = document.querySelector('#model-level');
const scoreText = value => value === 0 ? '0' : value < 0.001 ? value.toExponential(1) : value.toFixed(3);
const reason = document.querySelector('#diagnostic-reason');
const device = document.querySelector('#audio-device');
const refresh = document.querySelector('#refresh-devices');
const deviceHelp = document.querySelector('#device-help');
const processing = document.querySelector('#processing');
const inputStatus = document.querySelector('#input-status');
const listenButton = document.querySelector('#listen');
const listenResult = document.querySelector('#listen-result');
let lastInput = 0;
let deviceRequest = 0;

async function refreshDevices() {
    const request = ++deviceRequest;
    try {
        if (!navigator.mediaDevices?.enumerateDevices) throw new Error('Safari cannot list microphones in this page.');
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audioinput');
        if (request !== deviceRequest) return;
        const selected = device.value;
        const choices = [new Option('System default', '')];
        inputs.filter(item => item.deviceId).forEach((item, index) => choices.push(new Option(item.label || `Microphone ${index + 1}`, item.deviceId)));
        if (selected && !inputs.some(item => item.deviceId === selected)) choices.push(new Option('Previously selected microphone (unavailable)', selected));
        device.replaceChildren(...choices);
        device.value = selected;
        deviceHelp.textContent = inputs.some(item => item.label)
            ? 'Choose your built-in or external microphone. Stop before changing inputs.'
            : 'Start once to grant permission and show microphone names.';
    } catch (error) {
        if (request === deviceRequest) deviceHelp.textContent = error.message;
    }
}
let lastWindow = 0;
const messages = {
    idle: 'Microphone is off.',
    starting: 'Allow microphone access. Loading the local sound model…',
    listening: 'Listening for vocal reactions…',
    error: 'Audio detection stopped.'
};
const audio = createAudioDetector({
    onSpeech(data) {
        const messages = {
            loading: 'Words: loading the local speech-to-text and sentiment models…',
            listening: 'Words: ready. Say a short reaction, then pause.',
            hearing: 'Words: hearing a phrase…',
            transcribing: 'Words: transcribing…',
            disabled: 'Words: disabled.'
        };
        const reasons = {
            sentiment: 'sentiment',
            keyword: 'app keyword',
            'neutral-statement': 'neutral statement',
            uncertain: 'not clearly positive or negative',
            'no-words': 'no words recognized'
        };
        speechStatus.textContent = !data ? 'Words: microphone is off.'
            : data.status === 'unavailable' ? `Words unavailable: ${data.message} Laugh/groan detection is still active.`
            : data.status === 'result' ? `Heard “${data.transcript || '…'}” → ${data.signal} (${reasons[data.reason] || data.reason})` +
                (data.scores ? ` · positive ${scoreText(data.scores.positive)}, negative ${scoreText(data.scores.negative)}, neutral ${scoreText(data.scores.neutral)}` : '') +
                (data.transcribeMs != null ? ` · ${data.transcribeMs + data.sentimentMs} ms on the ${data.backend === 'gpu' ? 'GPU' : 'CPU'}` : '')
            : data.status === 'listening' && data.backend ? `${messages.listening} Running on the ${data.backend === 'gpu' ? 'GPU' : 'CPU'}.`
            : messages[data.status];
    },
    // Display only; decision.js uses listen() or onSignal, which never report neutral.
    onLabel(label) {
        output.textContent = label;
        output.dataset.signal = label;
    },
    onInput(data) {
        if (!data) {
            lastInput = 0;
            level.value = -80;
            mic.textContent = 'Microphone is off or starting.';
            inputStatus.textContent = 'Speak to check input; this meter updates independently of the AI model.';
            return;
        }
        lastInput = Date.now();
        level.value = Math.max(-80, data.inputDb);
        mic.textContent = `${data.microphone} · ${data.inputDb.toFixed(0)} dBFS`;
        inputStatus.textContent = !data.hasInput
            ? 'Safari is not delivering microphone channels. Stop, choose a different input, and restart.'
            : data.rms < 0.001
                ? 'Microphone is connected, but the input is nearly silent. Check input volume and mute switches.'
                : 'Microphone audio is arriving. The model result is shown below.';
    },
    onDiagnostics(data) {
        if (!data) {
            lastWindow = 0;
            detected.textContent = 'Detected sound: waiting for audio.';
            scores.textContent = 'Reaction scores: —';
            modelLevel.textContent = 'Model input: waiting for audio.';
            reason.textContent = 'Waiting for microphone samples…';
            return;
        }
        lastWindow = Date.now();
        detected.textContent = data.topSound ? `Detected sound: ${data.topSound} (score ${scoreText(data.topScore)})` : 'Detected sound: input too quiet to classify.';
        scores.textContent = data.positive == null ? 'Reaction scores: —' : `Smoothed positive: ${scoreText(data.positive)} · Negative: ${scoreText(data.negative)} · Required: ${data.threshold.toFixed(2)}` + (data.rawPositive == null ? '' : ` · Raw positive: ${scoreText(data.rawPositive)} · Raw negative: ${scoreText(data.rawNegative)}`);
        modelLevel.textContent = data.modelRms == null ? 'Model input: skipped because the microphone is too quiet.'
            : `Model input: ${(20 * Math.log10(Math.max(data.modelRms, 1e-8))).toFixed(0)} dBFS · automatic gain ×${data.inputGain.toFixed(1)}`;
        reason.textContent = ({
            quiet: 'Input is very quiet. Check the selected microphone and its input volume in macOS Sound settings.',
            'below-threshold': 'No reaction evidence detected.',
            ambiguous: 'Reaction evidence is tied or lacks a clear enough lead; output is neutral.',
            reaction: 'Vocal reaction detected.',
            classified: 'Audio has been analyzed.'
        })[data.reason];
        if (data.source === 'words') reason.textContent = 'Your last phrase is driving the reaction (held for 3 seconds).';
        if (data.source === 'sound') reason.textContent = 'A laugh or groan is driving the reaction (held for 3 seconds).';
    },
    onStateChange(state) {
        if (state === 'listening') {
            lastWindow = lastInput = Date.now();
            refreshDevices();
        }
        status.textContent = messages[state];
        start.disabled = state === 'starting' || state === 'listening';
        stop.disabled = !start.disabled;
        device.disabled = processing.disabled = start.disabled;
        listenButton.disabled = state !== 'listening';
    },
    onError(error) { status.textContent = error.message; }
});
// Distinguish a stalled capture pipeline from real neutral predictions.
setInterval(() => {
    if (audio.getState() === 'listening' && Date.now() - lastInput > 3000) {
        level.value = -80;
        inputStatus.textContent = 'No microphone samples have arrived for 3 seconds. Stop and restart, or check Safari microphone permission.';
    }
    if (audio.getState() === 'listening' && Date.now() - lastWindow > 6000) {
        reason.textContent = 'No audio analysis has arrived for 6 seconds. Stop and restart; if this persists, check microphone permissions or try the localhost test in README.md.';
    }
}, 1000);
refresh.addEventListener('click', refreshDevices);
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
refreshDevices();
start.addEventListener('click', () => { audio.start({ deviceId: device.value, processing: processing.checked }).catch(() => {}); });
stop.addEventListener('click', () => { audio.stop(); });
// Same request decision.js will make: wait up to 5 s for a positive/negative reaction.
listenButton.addEventListener('click', async () => {
    listenButton.disabled = true;
    listenResult.textContent = 'Listening for 5 seconds… react now.';
    try {
        const reaction = await audio.listen({ timeoutMs: 5000 });
        listenResult.textContent = reaction ? `Result sent: ${reaction}` : 'No positive or negative reaction in 5 seconds (nothing sent).';
    } catch (error) {
        listenResult.textContent = error.message;
    } finally {
        listenButton.disabled = audio.getState() !== 'listening';
    }
});
window.addEventListener('pagehide', () => { audio.stop(); });
