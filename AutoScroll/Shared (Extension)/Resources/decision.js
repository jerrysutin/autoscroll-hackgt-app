import { emotionProbabilities, getFacePresence, getScores, pushFrame, startCamera, stopCamera } from "./facialExpressionClassifier.js";
import { createAudioDetector } from "./audio.js";

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

// A spoken or vocal reaction ("skip this", a laugh) counts for this long.
const AUDIO_REACTION_MS = 3000;

// Face: the negative emotions' combined probability, averaged over this window,
// must reach the chosen sensitivity's threshold and outweigh the positive ones.
// (Requiring a negative emotion to be the single top label needed an
// exaggerated expression, because "neutral" usually wins.)
const FACE_WINDOW_MS = 1500;
const FACE_MIN_SAMPLES = 2;
export const FACE_SENSITIVITY = { low: 0.25, medium: 0.15, high: 0.1 };
let faceSensitivity = "medium";
let faceHistory = [];
let face = null;

export function setFaceSensitivity(value) {
  if (Object.hasOwn(FACE_SENSITIVITY, value)) {
    faceSensitivity = value;
  }
}

// For the status popup: the averaged negative share and the scroll threshold.
export function getFaceInfo() {
  return face && { ...face, threshold: FACE_SENSITIVITY[faceSensitivity], sensitivity: faceSensitivity };
}

function share(probabilities, emotions) {
  return emotions.reduce((total, emotion) => total + (probabilities[emotion] || 0), 0);
}

function decideFromFace(scores) {
  const probabilities = emotionProbabilities(scores);
  const now = Date.now();
  faceHistory.push({ at: now, negative: share(probabilities, negativeEmotions), positive: share(probabilities, positiveEmotions) });
  faceHistory = faceHistory.filter(sample => now - sample.at <= FACE_WINDOW_MS);

  const average = key => faceHistory.reduce((total, sample) => total + sample[key], 0) / faceHistory.length;
  face = { negative: average("negative"), positive: average("positive") };

  if (faceHistory.length >= FACE_MIN_SAMPLES &&
      face.negative >= FACE_SENSITIVITY[faceSensitivity] && face.negative > face.positive) {
    // Start over, so one expression does not trigger again right after its scroll.
    faceHistory = [];
    return true; // scroll
  }

  return false; // watch
}

// Latest microphone reaction: { signal: "positive" | "negative", at }.
// The detector never reports neutral, so silence leaves this empty.
let audioReaction = null;

// Last audio-analysis error ({ message, at }) or null; engine.js restarts after it.
let audioError = null;

export function getAudioError() {
  return audioError;
}

// For the status popup: speech-model state and the last phrase heard.
const speech = { models: "off", heard: null };

export function getSpeechInfo() {
  return { ...speech };
}

const audio = createAudioDetector({
  onSignal(signal) {
    audioReaction = { signal, at: Date.now() };
  },
  onError(error) {
    console.error("Audio:", error.message);
    audioError = { message: error.message, at: Date.now() };
  },
  onSpeech(status) {
    // Laughs and groans keep working if the speech models fail to load.
    if (status?.status === "unavailable") {
      console.warn("Speech recognition unavailable:", status.message);
    }
    if (status?.status === "result" || status?.status === "late") {
      speech.heard = { text: status.transcript, signal: status.signal, late: status.status === "late", at: Date.now() };
    } else if (status && !["hearing", "transcribing"].includes(status.status)) {
      speech.models = status.status === "unavailable" ? `unavailable: ${status.message}`
        : status.status === "listening" && status.backend ? `ready (${status.backend.toUpperCase()})` : status.status;
    }
  }
});


export { getFacePresence, pushFrame, startCamera, stopCamera };

// Browsers only allow the microphone to start from a user action, so call
// this from a click handler. Resolves true once listening.
export function startAudio(options) {
  return audio.start(options);
}

// "idle", "starting", "listening", or "error" (see audio.js).
export function audioState() {
  return audio.getState();
}

export function stopAudio() {
  audioReaction = null;
  return audio.stop();
}

function takeAudioReaction() {
  const reaction = audioReaction;
  audioReaction = null;

  if (!reaction || Date.now() - reaction.at > AUDIO_REACTION_MS) {
    return null;
  }

  return reaction.signal;
}

export function decide() {
  // A deliberate audio reaction overrides the face. It is used once, so one
  // "skip" cannot cause several scrolls when decide() is called repeatedly.
  const heard = takeAudioReaction();

  if (heard === "negative") {
    return true; // scroll
  }

  if (heard === "positive") {
    return false; // watch
  }

  const scores = getScores();

  if (!scores) {
    faceHistory = [];
    face = null;
    return null;
  }

  return decideFromFace(scores);
}
