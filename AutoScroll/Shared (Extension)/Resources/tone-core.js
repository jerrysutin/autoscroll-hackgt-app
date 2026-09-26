// Acoustic emotion estimates only: these are not word sentiment or user intent.
export function normalizeToneSamples(samples) {
    if (!samples.length || samples.some(value => !Number.isFinite(value))) throw new Error('Invalid tone samples.');
    let mean = 0;
    for (const value of samples) mean += value;
    mean /= samples.length;
    let variance = 0;
    for (const value of samples) variance += (value - mean) ** 2;
    const scale = Math.sqrt(variance / samples.length + 1e-7);
    return samples.map(value => (value - mean) / scale);
}

// Emotion families. Negative feeling is spread over four emotions while
// positive is one, so judge polarity from family totals, not the top emotion.
const POLARITY = {
    positive: ['happy'],
    negative: ['angry', 'disgust', 'fearful', 'sad'],
    neutral: ['calm', 'surprised']
};
// Tuned on CREMA-D clips (normal and low intensity; diagnostic, the model saw
// CREMA-D in training). Negative has a larger total to beat, so it needs a
// larger lead; this raises negative recall without more neutral false alarms.
export const TONE_GATES = {
    positive: { threshold: 0.55, margin: 0.15 },
    negative: { threshold: 0.7, margin: 0.5 }
};

export function describeTone(logits, labels) {
    if (!logits.length || logits.length !== Object.keys(labels).length || logits.some(value => !Number.isFinite(value))) {
        throw new Error('Invalid tone model output.');
    }
    const peak = Math.max(...logits);
    const weights = Array.from(logits, value => Math.exp(value - peak));
    const sum = weights.reduce((total, value) => total + value, 0);
    const scores = weights.map((value, index) => ({ label: labels[index].toLowerCase(), score: value / sum }));
    scores.sort((a, b) => b.score - a.score);
    const top = scores[0];
    const polarity = Object.fromEntries(Object.entries(POLARITY).map(([name, emotions]) =>
        [name, scores.filter(item => emotions.includes(item.label)).reduce((total, item) => total + item.score, 0)]));
    const lead = name => polarity[name] - Math.max(...Object.keys(polarity).filter(other => other !== name).map(other => polarity[other]));
    const passes = name => polarity[name] >= TONE_GATES[name].threshold && lead(name) >= TONE_GATES[name].margin;
    const candidate = polarity.negative > polarity.positive && polarity.negative > polarity.neutral ? 'negative'
        : polarity.positive > polarity.neutral && polarity.positive > polarity.negative ? 'positive' : 'neutral';
    const signal = candidate !== 'neutral' && passes(candidate) ? candidate : 'neutral';
    const gate = TONE_GATES[candidate] || TONE_GATES.positive;
    return { signal, candidate, reason: signal !== 'neutral' ? 'reaction' : candidate === 'neutral' ? 'neutral-emotion' : 'uncertain',
        lead: candidate === 'neutral' ? lead('neutral') : lead(candidate), emotion: top.label, score: top.score, scores, polarity,
        threshold: gate.threshold, margin: gate.margin };
}
