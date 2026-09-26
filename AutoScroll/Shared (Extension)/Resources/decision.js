import { classify, getLabel } from "./facialExpressionClassifier.js";

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
  const label = getLabel();

  if (!label) {
    return null;
  }

  const result = classify(label);

  if (negativeEmotions.includes(result)) {
    return "scroll";
  } else {
    return "watch";
  }
}