// Pure rules for spoken statements: transcript cleanup, sentiment gate, and
// app keywords. The worker runs the models; this file decides the label.

// Whisper invents these on silence, noise, or music. They are never reactions.
const HALLUCINATIONS = new Set(['you', 'thank you', 'thanks for watching', 'thank you for watching',
    'bye', 'okay', 'ok', 'so', 'uh', 'um', 'hmm', 'mm', 'oh']);

// A word repeated more than this many times in a row is a Whisper loop, not
// speech: "no, no, no" is kept, "la la la la la ..." is cut to three.
const MAX_REPEATS = 3;

function collapseRepeats(text) {
    const words = text.split(' ');
    const kept = [];
    let run = 0;
    words.forEach((word, index) => {
        const bare = word.toLowerCase().replace(/[^a-z']/g, '');
        const previous = index ? words[index - 1].toLowerCase().replace(/[^a-z']/g, '') : null;
        run = bare && bare === previous ? run + 1 : 1;
        if (run <= MAX_REPEATS) kept.push(word);
    });
    return kept.join(' ');
}

export function cleanTranscript(text) {
    const cleaned = collapseRepeats(String(text || '')
        .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim());
    const bare = cleaned.toLowerCase().replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim();
    // Also "you you you": a hallucination repeated is still a hallucination.
    const distinct = [...new Set(bare.split(' '))].join(' ');
    return !bare || HALLUCINATIONS.has(bare) || HALLUCINATIONS.has(distinct) ? '' : cleaned;
}

// Short scrolling commands and reactions that the sentiment model or a tiny
// speech model can miss ("Gross, next", "Yes, keep this"). Checked only when
// the model is not confident, and ignored after a nearby negation.
const KEYWORDS = {
    negative: ['skip', 'next', 'nope', 'boring', 'bored', 'gross', 'cringe', 'ew', 'eww', 'ugh', 'lame',
        'hate', 'awful', 'terrible', 'worst', 'annoying', 'stupid', 'dumb', 'stop'],
    positive: ['keep', 'love', 'lol', 'haha', 'hahaha', 'funny', 'hilarious', 'awesome', 'amazing',
        'cute', 'nice', 'cool', 'great', 'again', 'yes']
};
// "No, that's awful" is still negative, so "no" is not a negation here.
const NEGATIONS = new Set(['not', "don't", 'dont', "isn't", 'isnt', "wasn't", 'wasnt', 'never', "can't", 'cant']);

export function keywordSignal(text) {
    const words = String(text || '').toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
    const found = { positive: 0, negative: 0 };
    words.forEach((word, index) => {
        const negated = words.slice(Math.max(0, index - 2), index).some(before => NEGATIONS.has(before));
        for (const [signal, list] of Object.entries(KEYWORDS)) {
            if (!list.includes(word)) continue;
            // "not funny" flips; "don't skip" cancels.
            if (negated && signal === 'positive') found.negative++;
            else if (!negated) found[signal]++;
        }
    });
    if (found.negative > found.positive) return 'negative';
    if (found.positive > found.negative) return 'positive';
    return 'neutral';
}

// Tuned on 120 synthesized statements (30 phrases x 4 voices): a 0.5 score with
// a 0.2 lead keeps "I'll be right back" (positive 0.57, neutral 0.41) neutral.
export const SENTIMENT_GATE = { threshold: 0.5, margin: 0.2 };

export function describeStatement(text, scores) {
    const transcript = cleanTranscript(text);
    if (!transcript) return { signal: 'neutral', reason: 'no-words', transcript: '', scores: null };
    const normalized = Object.fromEntries(['positive', 'neutral', 'negative'].map(label => [label, Number(scores?.[label] ?? 0)]));
    if (Object.values(normalized).some(value => !Number.isFinite(value))) throw new Error('Invalid sentiment scores.');
    const ranked = Object.entries(normalized).sort((a, b) => b[1] - a[1]);
    const [top, score] = ranked[0];
    const lead = score - ranked[1][1];
    if (top !== 'neutral' && score >= SENTIMENT_GATE.threshold && lead >= SENTIMENT_GATE.margin) {
        return { signal: top, reason: 'sentiment', transcript, scores: normalized, score, lead };
    }
    const keyword = keywordSignal(transcript);
    if (keyword !== 'neutral') return { signal: keyword, reason: 'keyword', transcript, scores: normalized, score, lead };
    return { signal: 'neutral', reason: top === 'neutral' ? 'neutral-statement' : 'uncertain', transcript, scores: normalized, score, lead };
}
