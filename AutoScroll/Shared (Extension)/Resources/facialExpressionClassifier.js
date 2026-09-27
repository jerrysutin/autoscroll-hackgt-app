const video = document.getElementById("camera");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");

const frame = document.createElement("canvas");
const frameCtx = frame.getContext("2d");

const crop = document.createElement("canvas");
crop.width = crop.height = 64;
const cropCtx = crop.getContext("2d", { willReadFrequently: true });

const labels = [
  "neutral", "happiness", "surprise", "sadness",
  "anger", "disgust", "fear", "contempt"
];

const assetURL = path => new URL(path, import.meta.url).href;

let stream;
let stopped = true;
let stage = "Starting camera";
let latestScores = null;
let lastError = null;
// wanted: startCamera() was called and stopCamera() was not.
// running: the current start() loop, until it has released its models.
let wanted = false;
let running = null;
// External mode: frames arrive from elsewhere (see pushFrame) instead of this
// page's own camera. Used by the hidden engine frame on YouTube, because Safari
// mutes one capture when another site in the same tab starts capturing.
let external = false;
let externalFrame = null;
let externalFrameId = 0;
let wakeForFrame = null;

// Supplies the next camera frame (an ImageBitmap) in external mode.
export function pushFrame(bitmap) {
  if (!external || stopped) {
    bitmap.close?.();
    return;
  }
  externalFrame?.close?.();
  externalFrame = bitmap;
  externalFrameId++;
  // Frame arrival drives the loop, so a throttled timer in a hidden frame
  // does not slow face detection.
  wakeForFrame?.();
}

export function getScores() {
  return latestScores;
}

// Last camera or model error message, or null.
export function getCameraError() {
  return lastError;
}

let modelsReady = false;

// For the status popup: whether the face models are loaded, and frames received.
export function getCameraState() {
  return { modelsReady, frames: externalFrameId };
}

// Face presence. A reading older than FACE_LOST_MS is dropped, so a stale
// expression cannot keep deciding after you look away or leave.
const FACE_LOST_MS = 1000;
let lastFaceAt = 0;
let lastFrameAt = 0;
let lastTurn = null;

// Head turn from BlazeFace keypoints (0 right eye, 1 left eye, 2 nose tip): the
// nose's sideways offset from the midpoint between the eyes, relative to the
// distance between them. About 0 facing the camera; it grows as the head turns.
// A face turned past LOOK_AWAY_TURN counts as looking away: it is not scored
// (side views read as disgust or contempt) and counts as no face.
export const LOOK_AWAY_TURN = 0.35;

function headTurn(detection) {
  const [eyeA, eyeB, nose] = detection.keypoints || [];
  if (!eyeA || !eyeB || !nose) return 0;
  const ax = eyeA.x * frame.width;
  const bx = eyeB.x * frame.width;
  const eyes = Math.hypot(bx - ax, (eyeB.y - eyeA.y) * frame.height);
  return eyes ? Math.abs(nose.x * frame.width - (ax + bx) / 2) / eyes : 0;
}

// { known, absentMs, lookingAway, turn }. known is false without a working
// camera. absentMs: time since a face looking at the camera was last seen.
export function getFacePresence() {
  const now = Date.now();
  const known = modelsReady && now - lastFrameAt <= 2000;
  return {
    known,
    absentMs: known ? now - lastFaceAt : 0,
    lookingAway: known && lastTurn !== null && lastTurn > LOOK_AWAY_TURN,
    turn: known ? lastTurn : null
  };
}

function showError(error) {
  console.error(stage, error);
  lastError = `${stage}: ${error.message || error}`;

  const message = document.createElement("pre");
  message.textContent =
    `${stage}\n${String(error)}\n` +
    `File: ${error.sourceURL || error.fileName || "unknown"}`;

  Object.assign(message.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    zIndex: "9999",
    margin: "0",
    padding: "12px",
    color: "white",
    background: "rgba(0,0,0,0.8)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere"
  });

  document.body.appendChild(message);
}

export function stopCamera() {
  wanted = false;
  modelsReady = false;
  lastFaceAt = lastFrameAt = 0;
  lastTurn = null;
  stopped = true;
  latestScores = null;
  stream?.getTracks().forEach(track => track.stop());
  video.srcObject = null;
  externalFrame?.close?.();
  externalFrame = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
}

// Starts the camera and models; safe to call again. After a stop, waits for the
// previous loop to release its models before starting a new one.
// { external: true } reads frames from pushFrame() instead of opening the camera.
export async function startCamera({ external: useExternal = false } = {}) {
  if (wanted) return;
  wanted = true;
  external = useExternal;
  await running;
  if (!wanted) return;
  stopped = false;
  lastError = null;
  running = start();
}

function getBox(detection) {
  const b = detection.boundingBox;
  if (!b) return null;

  const x = Math.max(0, Math.min(frame.width, b.originX));
  const y = Math.max(0, Math.min(frame.height, b.originY));
  const right = Math.max(0, Math.min(frame.width, b.originX + b.width));
  const bottom = Math.max(0, Math.min(frame.height, b.originY + b.height));

  if (right <= x || bottom <= y) return null;

  return { x, y, width: right - x, height: bottom - y };
}

function makeInput(ort, box) {
  cropCtx.drawImage(
    frame,
    box.x, box.y, box.width, box.height,
    0, 0, 64, 64
  );

  const rgba = cropCtx.getImageData(0, 0, 64, 64).data;
  const data = new Float32Array(4096);

  for (let i = 0; i < data.length; i++) {
    const p = i * 4;

    // FER+ expects grayscale values 0–255, not 0–1.
    data[i] = Math.round(
      rgba[p] * 0.299 +
      rgba[p + 1] * 0.587 +
      rgba[p + 2] * 0.114
    );
  }

  return new ort.Tensor("float32", data, [1, 1, 64, 64]);
}

// Probability of each expression, e.g. { neutral: 0.7, sadness: 0.12, ... }.
export function emotionProbabilities(scores) {
  if (
    scores.length !== 8 ||
    !Array.from(scores).every(Number.isFinite)
  ) {
    throw new Error("Expected eight FER+ scores.");
  }

  const max = Math.max(...scores);
  const values = Array.from(scores, value => Math.exp(value - max));
  const sum = values.reduce((a, b) => a + b, 0);
  return Object.fromEntries(labels.map((label, index) => [label, values[index] / sum]));
}

export function classify(scores) {
  if (
    scores.length !== 8 ||
    !Array.from(scores).every(Number.isFinite)
  ) {
    throw new Error("Expected eight FER+ scores.");
  }

  const max = Math.max(...scores);
  const values = Array.from(scores, value => Math.exp(value - max));
  const sum = values.reduce((a, b) => a + b, 0);
  const index = values.indexOf(Math.max(...values));

  return {
    label: labels[index],
    confidence: values[index] / sum
  };
}

function draw(box, result) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  ctx.strokeStyle = "black";
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  ctx.font = "10px sans-serif";
  ctx.fillStyle = "black";
  ctx.textBaseline = "top";

  const text =
    `${result.label} ${(result.confidence * 100).toFixed(1)}%`;

  const x = Math.max(
    0,
    Math.min(box.x, overlay.width - ctx.measureText(text).width)
  );
  const y = Math.max(0, box.y - 20);

  ctx.fillText(text, x, y);
}

async function start() {
  let detector;
  let session;

  try {
    if (!external) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 }
        },
        audio: false
      });

      if (stopped) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      stream.getVideoTracks()[0].addEventListener(
        "ended", stopCamera, { once: true }
      );

      video.srcObject = stream;
      await video.play();
      if (stopped) return;
    }

    stage = "Loading MediaPipe JavaScript";
    console.log(stage);

    const { FaceDetector, FilesetResolver } = await import(
      "./vendor/mediapipe/vision_bundle.mjs"
    );
    if (stopped) return;

    stage = "Loading ONNX Runtime JavaScript";
    console.log(stage);

    const ort = await import("./vendor/onnx/ort.wasm.min.mjs");
    if (stopped) return;

    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = assetURL("vendor/onnx/");

    stage = "Loading MediaPipe WASM";
    const vision = await FilesetResolver.forVisionTasks(
      assetURL("vendor/mediapipe/wasm")
    );
    if (stopped) return;

    stage = "Loading face detector model";
    detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: assetURL(
          "models/blaze_face_short_range.tflite"
        ),
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.5
    });
    if (stopped) return;

    stage = "Loading FER+ model and ONNX WASM";
    session = await ort.InferenceSession.create(
      assetURL("models/emotion-ferplus-8.onnx"),
      { executionProviders: ["wasm"] }
    );
    if (stopped) return;

    if (
      session.inputNames.length !== 1 ||
      session.outputNames.length !== 1
    ) {
      throw new Error("Use the emotion-ferplus-8.onnx model.");
    }

    console.log("Both models ready");
    modelsReady = true;
    let lastTime = -1;

    while (!stopped) {
      const started = performance.now();

      // Keep reading faces when the AutoScroll window is covered by the reels
      // window (macOS then reports it as hidden); only new frames are used.
      const source = external ? externalFrame : video;
      const hasFrame = external ? Boolean(source) : video.readyState >= 2;
      const time = external ? externalFrameId : video.currentTime;

      if (hasFrame && time !== lastTime) {
        lastTime = time;
        const width = external ? source.width : video.videoWidth;
        const height = external ? source.height : video.videoHeight;

        if (frame.width !== width || frame.height !== height) {
          frame.width = overlay.width = width;
          frame.height = overlay.height = height;
        }

        frameCtx.drawImage(source, 0, 0, frame.width, frame.height);

        stage = "Detecting face";
        const faces = detector.detectForVideo(frame, started)
          .detections
          .map(detection => ({ box: getBox(detection), turn: headTurn(detection) }))
          .filter(face => face.box)
          .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);

        const box = faces[0]?.turn <= LOOK_AWAY_TURN ? faces[0].box : null;

        lastFrameAt = Date.now();
        lastTurn = faces[0] ? faces[0].turn : null;

        if (!box) {
          // No face, or a face turned away.
          ctx.clearRect(0, 0, overlay.width, overlay.height);
          // Brief misses keep the last reading; a longer absence drops it.
          if (Date.now() - lastFaceAt > FACE_LOST_MS) latestScores = null;
        } else {
          stage = "Classifying expression";
          const input = makeInput(ort, box);
          let outputs;

          try {
            outputs = await session.run({
              [session.inputNames[0]]: input
            });

            if (stopped) break;

            const scores = outputs[session.outputNames[0]].data;

            latestScores = Array.from(scores);
            lastFaceAt = Date.now();

            const result = classify(scores);
            draw(box, result);
          } finally {
            input.dispose();
            if (outputs) {
              Object.values(outputs).forEach(t => t.dispose());
            }
          }
        }
      }

      await new Promise(resolve => {
        const delay = Math.max(0, 100 - (performance.now() - started));
        if (external) {
          // Wake on the next frame, or after 1 s at most. The timer belongs to
          // this wait only, so it cannot cut a later wait short.
          const wake = () => {
            if (wakeForFrame === wake) wakeForFrame = null;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(wake, Math.max(delay, 1000));
          wakeForFrame = wake;
        } else {
          setTimeout(resolve, delay);
        }
      });
    }
  } catch (error) {
    if (!stopped) {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      showError(error);
    }
    // Leave the live camera running so model errors don't hide the video.
  } finally {
    // Release AI resources only after pending inference has completed.
    try {
      detector?.close();
    } catch (error) {
      console.error(error);
    }

    try {
      await session?.release();
    } catch (error) {
      console.error(error);
    }
  }
}

window.addEventListener("pagehide", stopCamera);