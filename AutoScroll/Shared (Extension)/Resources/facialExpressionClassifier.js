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
let stopped = false;
let stage = "Starting camera";
let latestScores = null;

export function getScores() {
  return latestScores;
}

function showError(error) {
  console.error(stage, error);

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

function stopCamera() {
  stopped = true;
  stream?.getTracks().forEach(track => track.stop());
  video.srcObject = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
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
    let lastTime = -1;

    while (!stopped) {
      const started = performance.now();

      if (
        !document.hidden &&
        video.readyState >= 2 &&
        video.currentTime !== lastTime
      ) {
        lastTime = video.currentTime;

        if (
          frame.width !== video.videoWidth ||
          frame.height !== video.videoHeight
        ) {
          frame.width = overlay.width = video.videoWidth;
          frame.height = overlay.height = video.videoHeight;
        }

        frameCtx.drawImage(video, 0, 0, frame.width, frame.height);

        stage = "Detecting face";
        const boxes = detector.detectForVideo(frame, started)
          .detections
          .map(getBox)
          .filter(Boolean)
          .sort((a, b) => b.width * b.height - a.width * a.height);

        const box = boxes[0];

        if (!box) {
          ctx.clearRect(0, 0, overlay.width, overlay.height);
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
        setTimeout(resolve, Math.max(0, 100 - (performance.now() - started)));
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
start();