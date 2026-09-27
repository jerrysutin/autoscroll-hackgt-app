// Preparing a detected face for the expression model (EmotiEffLib
// enet_b0_8_va_mtl, see models/SOURCES.json), and measuring head turn. Pure
// functions, shared by facialExpressionClassifier.js and its tests.

// The face box is widened to a square MARGIN times its larger side. On real
// expression videos, 1.2 separated neutral from angry and sad faces best.
export const FACE_PREP = { margin: 1.2, size: 224 };

// A square crop around the box's centre, `margin` times its larger side, kept
// inside the frame (shifted rather than shrunk where possible).
export function squareCrop(box, frameWidth, frameHeight, margin = FACE_PREP.margin) {
  const size = Math.min(Math.max(box.width, box.height) * margin, frameWidth, frameHeight);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return {
    x: Math.min(Math.max(0, centerX - size / 2), frameWidth - size),
    y: Math.min(Math.max(0, centerY - size / 2), frameHeight - size),
    width: size,
    height: size
  };
}

// RGBA pixels of a size x size crop to the model's input: RGB planes (1x3xHxW),
// scaled to 0-1 and normalized with the ImageNet mean and standard deviation.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export function toModelInput(rgba, size = FACE_PREP.size) {
  const pixels = size * size;
  const data = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    for (let channel = 0; channel < 3; channel++) {
      data[channel * pixels + i] = (rgba[i * 4 + channel] / 255 - MEAN[channel]) / STD[channel];
    }
  }
  return data;
}

// Head turn from BlazeFace keypoints (0 right eye, 1 left eye, 2 nose tip,
// normalized to the frame): the nose's sideways offset from the midpoint
// between the eyes, relative to the distance between them. About 0 facing the
// camera; it grows as the head turns.
// On real videos, faces toward the camera measured 0.03-0.16 (90th percentile)
// and side-camera views 0.30 and 0.51, so 0.25 separates them.
export const LOOK_AWAY_TURN = 0.25;

export function headTurn(keypoints, frameWidth, frameHeight) {
  const [eyeA, eyeB, nose] = keypoints || [];
  if (!eyeA || !eyeB || !nose) return 0;
  const ax = eyeA.x * frameWidth;
  const bx = eyeB.x * frameWidth;
  const eyes = Math.hypot(bx - ax, (eyeB.y - eyeA.y) * frameHeight);
  return eyes ? Math.abs(nose.x * frameWidth - (ax + bx) / 2) / eyes : 0;
}
