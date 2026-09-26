import { classify, getScores } from "./facialExpressionClassifier.js";

const positiveEmotions = [
  "happiness",
  "surprise"
];

const neutralEmotions = [
  "neutral"
];

const negativeEmotions = [
  "sadness",
  "anger",
  "disgust",
  "fear",
  "contempt"
];

export function decide() {
  const scores = getScores();

  if (!scores) {
    return null;
  }

  const result = classify(scores);

  if (negativeEmotions.includes(result.label)) {
    return true; // scroll
  } else {
    return false; // watch
  }
}