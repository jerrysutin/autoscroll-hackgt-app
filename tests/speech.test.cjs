const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources');
const assets = path.join(root, 'speech-assets');
const core = import(`data:text/javascript;base64,${fs.readFileSync(path.join(root, 'speech-core.js')).toString('base64')}`);
const scores = (positive, neutral, negative) => ({ positive, neutral, negative });

test('confident sentiment decides; a narrow lead stays neutral', async () => {
    const { describeStatement } = await core;
    assert.equal(describeStatement("That's hilarious. I love it.", scores(0.95, 0.04, 0.01)).signal, 'positive');
    assert.equal(describeStatement('This is so boring.', scores(0.01, 0.1, 0.89)).signal, 'negative');
    const narrow = describeStatement("I'll be right back.", scores(0.57, 0.41, 0.02));
    assert.equal(narrow.signal, 'neutral', 'measured false positive: 0.57 vs 0.41');
    assert.equal(narrow.reason, 'uncertain');
    assert.equal(describeStatement("I'm going to get some water.", scores(0.05, 0.9, 0.05)).reason, 'neutral-statement');
    assert.throws(() => describeStatement('hi there', scores(NaN, 0, 0)), /Invalid/);
});

test('app keywords rescue short commands the model scores as neutral', async () => {
    const { describeStatement } = await core;
    // Real misses from the evaluation: Whisper heard "Gross, next" as "Crows. Next."
    assert.equal(describeStatement('Crows. Next.', scores(0.06, 0.58, 0.36)).signal, 'negative');
    assert.equal(describeStatement('Yes, keep this.', scores(0.51, 0.45, 0.04)).signal, 'positive');
    assert.equal(describeStatement('Yes, keep this.', scores(0.51, 0.45, 0.04)).reason, 'keyword');
    // A confident model result is never overridden by a keyword.
    assert.equal(describeStatement('Next one is going to be great', scores(0.9, 0.08, 0.02)).signal, 'positive');
});

test('negation flips positive keywords and cancels negative ones', async () => {
    const { keywordSignal } = await core;
    assert.equal(keywordSignal('not funny'), 'negative');
    assert.equal(keywordSignal("that isn't cool"), 'negative');
    assert.equal(keywordSignal("don't skip this"), 'neutral');
    assert.equal(keywordSignal("No, that's awful"), 'negative', '"no" is a reaction, not a negation');
    assert.equal(keywordSignal('what time is it'), 'neutral');
});

test('Whisper hallucinations and bracketed noise tags are not statements', async () => {
    const { describeStatement, cleanTranscript } = await core;
    for (const text of ['', ' you', 'Thank you.', '[BLANK_AUDIO]', '(music)', '♪♪', '*laughs*', 'Um.']) {
        assert.equal(describeStatement(text, scores(0.9, 0.05, 0.05)).reason, 'no-words', JSON.stringify(text));
    }
    assert.equal(cleanTranscript('[Music] this is great'), 'this is great');
});

test('bundled speech assets match pinned hashes', () => {
    const sources = JSON.parse(fs.readFileSync(path.join(assets, 'SOURCES.json')));
    assert.ok(Object.keys(sources.files).length >= 20);
    for (const [file, info] of Object.entries(sources.files)) {
        assert.equal(createHash('sha256').update(fs.readFileSync(path.join(assets, file))).digest('hex'), info.sha256, file);
    }
});
