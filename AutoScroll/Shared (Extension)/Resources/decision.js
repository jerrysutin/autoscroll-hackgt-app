import { classify } from "./facialExpressionClassifier.js";

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

export function decide(emotion) {
  if (negativeEmotions.includes(emotion)) {
    return "scroll";
  } else {
    return "watch";
  }
}