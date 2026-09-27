// Hidden AutoScroll engine. extension-interaction.js adds this page as an
// invisible frame on YouTube Shorts while AutoScroll is on (toolbar popup).
// The page captures the microphone and camera: a hidden cross-origin frame
// cannot start audio without a click inside it, and Safari mutes one capture
// when another site in the same tab starts capturing. So:
// - framed audio arrives as AUTOSCROLL_MIC_* messages and feeds audio.js;
// - camera frames arrive as AUTOSCROLL_CAMERA_FRAME (raw pixels) and feed the
//   face classifier in its external mode.
// - Twice a second (on the page's AUTOSCROLL_TICK), posts decide()'s result and
//   a status report to the page.
// Every message carries the token from this frame's URL.
import { LOOK_AWAY_TURN, getCameraError, getCameraState, getScores } from "./facialExpressionClassifier.js";
import { audioState, decide, getAudioError, getFaceInfo, getFacePresence, getSpeechInfo, pushFrame, setFaceSensitivity, startAudio, startCamera } from "./decision.js";

const DECIDE_MS = 500;
// After audio-analysis errors, wait longer before each restart.
const AUDIO_RETRY_MS = [3000, 10000, 30000];
// Sound windows older than this are skipped; a laugh or groan should count only
// right away. (Phrases have their own limit in audio.js.)
const MAX_WINDOW_AGE_MS = 2000;
let audioFailures = 0;
let lastFailureAt = null;
// Status is re-sent at least this often, so the popup can tell the engine is alive.
const HEARTBEAT_MS = 2000;
const token = location.hash.slice(1);
const pageOrigin = location.ancestorOrigins?.[0] || "*";

let announced = false;
let lastDecision = null;
let lastStatus = "";
let lastReport = 0;
let lastTick = 0;
let onMicPacket = null;
// Messages received from the page, for the popup's Link row.
const received = { messages: 0, micPackets: 0, cameraFrames: 0 };
let onMicError = null;

function post(message) {
  parent.postMessage({ ...message, token }, pageOrigin);
}

// The page's microphone, as an external input for audio.js.
function pageMicrophone({ sampleRate, label }) {
  return {
    sampleRate,
    label,
    open(options, onPacket, onError) {
      onMicPacket = onPacket;
      onMicError = onError;
      post({ type: "AUTOSCROLL_MIC_CONFIG", options });
    },
    close() {
      onMicPacket = onMicError = null;
      post({ type: "AUTOSCROLL_MIC_STOP" });
    }
  };
}

window.addEventListener("message", event => {
  const data = event.data;
  if (event.source !== parent || data?.token !== token) return;
  received.messages++;

  if (data.type === "AUTOSCROLL_MIC_FORMAT") {
    // The page repeats this until it gets AUTOSCROLL_MIC_CONFIG back, including
    // after a failure (it keeps the microphone on), so analysis restarts itself.
    if (audioState() === "listening" || audioState() === "starting") return;
    const failedAt = getAudioError()?.at;
    if (failedAt && failedAt !== lastFailureAt) {
      lastFailureAt = failedAt;
      audioFailures++;
    }
    const wait = AUDIO_RETRY_MS[Math.min(audioFailures, AUDIO_RETRY_MS.length) - 1];
    if (failedAt && Date.now() - failedAt < wait) return;
    startAudio({ input: pageMicrophone(data) }).catch(error => {
      console.warn("AutoScroll microphone:", error.message);
    });
  } else if (data.type === "AUTOSCROLL_TICK") {
    setFaceSensitivity(data.faceSensitivity);
    // Presence on every tick (4 a second), so a pause follows quickly.
    post({ type: "AUTOSCROLL_PRESENCE", presence: getFacePresence() });
    tick();
  } else if (data.type === "AUTOSCROLL_CAMERA_FRAME") {
    received.cameraFrames++;
    const pixels = new ImageData(new Uint8ClampedArray(data.pixels), data.width, data.height);
    createImageBitmap(pixels)
      .then(pushFrame, error => console.warn("AutoScroll camera frame:", error))
      .finally(() => post({ type: "AUTOSCROLL_FRAME_DONE" })); // lets the page send the next one
  } else if (data.type === "AUTOSCROLL_MIC_PACKET") {
    received.micPackets++;
    const packet = data.packet;
    if (packet?.type === "window" && Date.now() - packet.capturedAt > MAX_WINDOW_AGE_MS) return;
    onMicPacket?.(packet);
  } else if (data.type === "AUTOSCROLL_MIC_ERROR") {
    onMicError?.(new Error(data.message));
  }
});

// "· 12% negative (scrolls at 30%)", so the right sensitivity can be picked.
function describeFace(info) {
  if (!info) return "";
  const percent = value => `${Math.round(value * 100)}%`;
  return ` · ${percent(info.negative)} negative (scrolls at ${percent(info.threshold)})`;
}

function report(status) {
  const text = JSON.stringify(status);
  if (text === lastStatus && Date.now() - lastReport < HEARTBEAT_MS) return;
  lastStatus = text;
  lastReport = Date.now();
  post({ type: "AUTOSCROLL_STATUS", status });
}

// Driven by AUTOSCROLL_TICK from the page (Safari may throttle timers in a hidden
// frame from another site), with this frame's own timer as a backup.
function tick() {
  if (Date.now() - lastTick < DECIDE_MS * 0.8) return;
  lastTick = Date.now();
  // A minute of working audio clears the restart backoff.
  if (audioFailures && audioState() === "listening" && Date.now() - lastFailureAt > 60000) {
    audioFailures = 0;
  }

  const face = Boolean(getScores());
  const microphone = audioState();
  const cameraError = getCameraError();

  if ((face || microphone === "listening") && !announced) {
    announced = true;
    post({ type: "AUTOSCROLL_READY" });
  }

  const decision = decide();

  if (decision !== null) {
    lastDecision = decision ? "scroll" : "watch";
    post({ type: "AUTOSCROLL_DECISION", decision });
  }

  const { modelsReady, frames } = getCameraState();
  const presence = getFacePresence();
  const turn = presence.turn === null ? "" : ` · turned ${Math.round(presence.turn * 100)}%`;
  report({
    camera: cameraError ? `error: ${cameraError}`
      : !frames ? "no camera frames yet"
      : !modelsReady ? "loading face models…"
      : presence.lookingAway ? `looking away${turn} (away at ${Math.round(LOOK_AWAY_TURN * 100)}%)`
      : face ? `sees your face${describeFace(getFaceInfo())}${turn}` : "looking for your face",
    microphone,
    audioError: getAudioError()?.message || null,
    speech: getSpeechInfo(),
    received: { ...received },
    lastDecision
  });
}

startCamera({ external: true });
setInterval(tick, DECIDE_MS);
post({ type: "AUTOSCROLL_ENGINE_READY" });
