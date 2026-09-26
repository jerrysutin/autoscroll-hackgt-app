// Capture mono PCM away from the UI thread. Never play the microphone back.
class AutoScrollMicrophone extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.buffer = new Float32Array(options.processorOptions.windowSamples);
        this.offset = 0;
    }

    process(inputs, outputs) {
        for (const output of outputs) for (const channel of output) channel.fill(0);
        const channels = inputs[0];
        if (!channels?.length) return true;
        for (let i = 0; i < channels[0].length; i++) {
            let sample = 0;
            for (const channel of channels) sample += channel[i];
            this.buffer[this.offset++] = sample / channels.length;
            if (this.offset === this.buffer.length) {
                const length = this.buffer.length;
                this.port.postMessage(this.buffer, [this.buffer.buffer]);
                this.buffer = new Float32Array(length);
                this.offset = 0;
            }
        }
        return true;
    }
}
registerProcessor('autoscroll-microphone', AutoScrollMicrophone);
