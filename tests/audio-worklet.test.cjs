const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources/audio-worklet.js'), 'utf8');

function capture(options = {}) {
    const messages = [];
    let Processor;
    class AudioWorkletProcessor {
        constructor() {
            this.port = { postMessage(message, transfer = []) {
                messages.push(structuredClone(message, { transfer }));
                if (transfer.length) assert.equal(message.samples.length, 0, 'transferred PCM is detached');
            } };
        }
    }
    vm.runInNewContext(source, {
        AudioWorkletProcessor, Float32Array,
        registerProcessor(name, value) { assert.equal(name, 'autoscroll-microphone'); Processor = value; }
    });
    const processor = new Processor({ processorOptions: {
        windowSamples: 6, hopSamples: 2, meterSamples: 2, ...options
    } });
    return {
        processor, messages,
        feed(values) { processor.process([[Float32Array.from(values)]], [[]]); },
        missing(count) { processor.process([], [[new Float32Array(count).fill(1)]]); },
        ofType(type) { return messages.filter(message => message.type === type); }
    };
}

function phrases(options = {}) {
    return capture({ phraseFrameSamples: 2, phraseMinSamples: 4, phraseMaxSamples: 20,
        phraseSilenceSamples: 6, phrasePreRollSamples: 2, phraseRmsThreshold: 0.01, ...options });
}

test('timestamped YAMNet windows preserve overlap, downmix, transfers, and silent output', () => {
    const env = capture();
    const output = [new Float32Array(10).fill(1), new Float32Array(10).fill(1)];
    env.processor.process([[
        Float32Array.from([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]),
        Float32Array.from([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    ]], [output]);
    assert.ok(output.every(channel => channel.every(sample => sample === 0)));
    assert.deepEqual(env.ofType('window').map(packet => [packet.startSample, packet.endSample, Array.from(packet.samples)]), [
        [0, 6, [1, 3, 5, 7, 9, 11]],
        [2, 8, [5, 7, 9, 11, 13, 15]],
        [4, 10, [9, 11, 13, 15, 17, 19]]
    ]);
    assert.deepEqual(env.ofType('level').map(packet => packet.endSample), [2, 4, 6, 8, 10]);
});

test('a short statement finalizes at a pause with pre-roll and trimmed trailing silence', () => {
    const env = phrases();
    env.feed([0, 0, 0, 0, 1, 1, 2]);
    env.feed([2, 3, 3, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(env.ofType('phrase-start'), [{ type: 'phrase-start', utteranceId: 1, startSample: 2 }]);
    const [packet] = env.ofType('phrase');
    assert.deepEqual({ ...packet, samples: Array.from(packet.samples) }, {
        type: 'phrase', utteranceId: 1, startSample: 2, endSample: 12, activeSamples: 6, finalized: 'silence',
        samples: [0, 0, 1, 1, 2, 2, 3, 3, 0, 0]
    });
    assert.equal(env.processor.utteranceId, null);
});

test('brief clicks and silence never produce a phrase packet', () => {
    const env = phrases();
    env.feed([0, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
    assert.equal(env.ofType('phrase-start').length, 1, 'new activity can invalidate an older reaction');
    assert.equal(env.ofType('phrase').length, 0);
    env.feed(new Array(100).fill(0.001));
    assert.equal(env.ofType('phrase-start').length, 1);
    assert.equal(env.ofType('phrase').length, 0);
});

test('missing channels advance timestamps and end speech exactly as silence does', () => {
    const env = phrases();
    env.feed([1, 1, 2, 2, 3, 3]);
    env.missing(6);
    const [packet] = env.ofType('phrase');
    assert.equal(packet.finalized, 'silence');
    assert.equal(packet.endSample, 8);
    assert.deepEqual(Array.from(packet.samples), [1, 1, 2, 2, 3, 3, 0, 0]);
    assert.equal(env.ofType('level').at(-1).endSample, 12);
    assert.equal(env.ofType('level').at(-1).hasInput, false);
    assert.deepEqual(Array.from(env.ofType('window').at(-1).samples), [0, 0, 0, 0, 0, 0]);
    env.feed([4, 4, 5, 5]);
    assert.equal(env.ofType('phrase-start').at(-1).utteranceId, 2);
});

test('long continuous speech stays bounded and retains its utterance ID across maximum chunks', () => {
    const env = phrases({ phraseMaxSamples: 9, phraseMinSamples: 2 });
    env.feed(new Array(24).fill(1));
    env.feed(new Array(6).fill(0));
    assert.equal(env.ofType('phrase-start').length, 1);
    const packets = env.ofType('phrase');
    assert.deepEqual(packets.map(packet => [packet.utteranceId, packet.startSample, packet.endSample,
        packet.activeSamples, packet.finalized]), [
        [1, 0, 9, 9, 'max'], [1, 9, 18, 9, 'max'], [1, 18, 26, 6, 'max']
    ]);
    assert.ok(packets.every(packet => packet.samples.length <= 9));
    assert.equal(env.processor.phraseBuffer.length, 9);
    assert.equal(env.processor.utteranceId, null);
    env.feed([2, 2, 2, 2, 0, 0, 0, 0, 0, 0]);
    assert.equal(env.ofType('phrase-start').at(-1).utteranceId, 2);
});

test('a brief pause remains one phrase and real utterance boundaries get different IDs', () => {
    const env = phrases({ phraseMaxSamples: 30 });
    env.feed([1, 1, 1, 1, 0, 0, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0]);
    env.feed([3, 3, 3, 3, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(env.ofType('phrase').map(packet => [packet.utteranceId, packet.activeSamples]), [[1, 8], [2, 4]]);
    assert.deepEqual(env.ofType('phrase-start').map(packet => packet.utteranceId), [1, 2]);
});
