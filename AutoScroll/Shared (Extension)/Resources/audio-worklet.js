// Capture mono PCM away from the UI thread. Never play the microphone back.
class AutoScrollMicrophone extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const config = options.processorOptions;
        this.buffer = new Float32Array(config.windowSamples);
        this.offset = 0;
        this.hopSamples = Math.max(1, Math.min(this.buffer.length, config.hopSamples || this.buffer.length));
        this.totalSamples = 0;
        this.meterSamples = config.meterSamples || 0;
        this.meterCount = 0;
        this.meterEnergy = 0;
        this.meterHadInput = false;

        // Energy only locates candidate phrases. The main thread separately checks
        // YAMNet voice evidence before transcribing one.
        this.phraseFrame = config.phraseFrameSamples && config.phraseMaxSamples
            ? new Float32Array(config.phraseFrameSamples) : null;
        this.phraseFrameOffset = 0;
        this.phraseFrameEnergy = 0;
        this.phraseThreshold = config.phraseRmsThreshold ?? 0.003;
        this.phraseMin = config.phraseMinSamples || config.phraseFrameSamples;
        this.phraseSilence = config.phraseSilenceSamples || config.phraseFrameSamples;
        this.phrasePreRoll = new Float32Array(config.phrasePreRollSamples || 0);
        this.preRollOffset = 0;
        this.preRollCount = 0;
        this.phraseBuffer = this.phraseFrame ? new Float32Array(config.phraseMaxSamples) : null;
        this.phraseLength = 0;
        this.phraseActiveSamples = 0;
        this.phraseSilentSamples = 0;
        this.phraseStartSample = 0;
        this.lastActiveSample = 0;
        this.utteranceId = null;
        this.nextUtteranceId = 1;
    }

    reportLevel(energy, hasInput) {
        if (!this.meterSamples) return;
        this.meterEnergy += energy;
        this.meterCount++;
        this.meterHadInput ||= hasInput;
        if (this.meterCount >= this.meterSamples) {
            this.port.postMessage({ type: 'level', rms: Math.sqrt(this.meterEnergy / this.meterCount),
                hasInput: this.meterHadInput, endSample: this.totalSamples });
            this.meterCount = 0;
            this.meterEnergy = 0;
            this.meterHadInput = false;
        }
    }

    rememberFrame(frame) {
        if (!this.phrasePreRoll.length) return;
        for (const sample of frame) {
            this.phrasePreRoll[this.preRollOffset] = sample;
            this.preRollOffset = (this.preRollOffset + 1) % this.phrasePreRoll.length;
            this.preRollCount = Math.min(this.preRollCount + 1, this.phrasePreRoll.length);
        }
    }

    startPhrase(frameStart) {
        this.utteranceId = this.nextUtteranceId++;
        // Leave room for current activity even with an oversized pre-roll option.
        const count = Math.min(this.preRollCount, this.phraseBuffer.length - 1);
        const offset = count ? (this.preRollOffset - count + this.phrasePreRoll.length) % this.phrasePreRoll.length : 0;
        for (let i = 0; i < count; i++) {
            this.phraseBuffer[i] = this.phrasePreRoll[(offset + i) % this.phrasePreRoll.length];
        }
        this.phraseLength = count;
        this.phraseActiveSamples = 0;
        this.phraseSilentSamples = 0;
        this.phraseStartSample = frameStart - count;
        this.port.postMessage({ type: 'phrase-start', utteranceId: this.utteranceId, startSample: this.phraseStartSample });
    }

    finishChunk(finalized, nextSample) {
        // Keep a little ending context, but do not normalize long trailing silence
        // together with speech. Pre-roll also sets the amount of ending context.
        const endSample = Math.min(this.phraseStartSample + this.phraseLength,
            this.lastActiveSample + this.phrasePreRoll.length);
        const length = Math.max(0, endSample - this.phraseStartSample);
        if (this.phraseActiveSamples >= this.phraseMin && length) {
            const samples = this.phraseBuffer.slice(0, length);
            this.port.postMessage({ type: 'phrase', samples, utteranceId: this.utteranceId,
                startSample: this.phraseStartSample, endSample,
                activeSamples: this.phraseActiveSamples, finalized }, [samples.buffer]);
        }
        this.phraseLength = 0;
        this.phraseActiveSamples = 0;
        this.phraseStartSample = nextSample;
        // Continuous speech uses the same ID across bounded chunks. Only a real
        // pause ends an utterance, so a new chunk cannot cancel its own inference.
        if (finalized === 'silence') {
            this.utteranceId = null;
            this.phraseSilentSamples = 0;
        }
    }

    processPhraseFrame(frameStart) {
        const voiced = Math.sqrt(this.phraseFrameEnergy / this.phraseFrame.length) >= this.phraseThreshold;
        if (voiced && this.utteranceId === null) this.startPhrase(frameStart);
        let offset = 0;
        while (this.utteranceId !== null && offset < this.phraseFrame.length) {
            const count = Math.min(this.phraseFrame.length - offset,
                this.phraseBuffer.length - this.phraseLength,
                voiced ? Infinity : this.phraseSilence - this.phraseSilentSamples);
            this.phraseBuffer.set(this.phraseFrame.subarray(offset, offset + count), this.phraseLength);
            this.phraseLength += count;
            offset += count;
            if (voiced) {
                this.phraseActiveSamples += count;
                this.phraseSilentSamples = 0;
                this.lastActiveSample = frameStart + offset;
            } else {
                this.phraseSilentSamples += count;
            }
            if (this.phraseSilentSamples >= this.phraseSilence) {
                this.finishChunk('silence', frameStart + offset);
            } else if (this.phraseLength === this.phraseBuffer.length) {
                this.finishChunk('max', frameStart + offset);
            }
        }
        this.rememberFrame(this.phraseFrame);
        this.phraseFrameOffset = 0;
        this.phraseFrameEnergy = 0;
    }

    process(inputs, outputs) {
        for (const output of outputs) for (const channel of output) channel.fill(0);
        const channels = inputs[0];
        const hasInput = Boolean(channels?.length && channels[0].length);
        const count = hasInput ? channels[0].length : outputs[0]?.[0]?.length || 128;
        // Missing input advances the same clock and silence endpoint as real
        // zero samples. No partial phrase can survive a disconnected input.
        for (let i = 0; i < count; i++) {
            let sample = 0;
            if (hasInput) {
                for (const channel of channels) sample += channel[i];
                sample /= channels.length;
            }
            this.totalSamples++;
            this.reportLevel(sample * sample, hasInput);
            if (this.phraseFrame) {
                this.phraseFrame[this.phraseFrameOffset++] = sample;
                this.phraseFrameEnergy += sample * sample;
                if (this.phraseFrameOffset === this.phraseFrame.length) {
                    this.processPhraseFrame(this.totalSamples - this.phraseFrame.length);
                }
            }
            this.buffer[this.offset++] = sample;
            if (this.offset === this.buffer.length) {
                const length = this.buffer.length;
                const next = new Float32Array(length);
                next.set(this.buffer.subarray(this.hopSamples));
                this.port.postMessage({ type: 'window', samples: this.buffer,
                    startSample: this.totalSamples - length, endSample: this.totalSamples }, [this.buffer.buffer]);
                this.buffer = next;
                this.offset = length - this.hopSamples;
            }
        }
        return true;
    }
}
registerProcessor('autoscroll-microphone', AutoScrollMicrophone);
