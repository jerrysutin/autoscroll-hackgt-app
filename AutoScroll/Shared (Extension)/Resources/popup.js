// Toolbar popup: turns AutoScroll on or off and shows the Shorts tab's status.
// extension-interaction.js reacts to "enabled" immediately and reports "page"
// (engine frame, microphone, camera, last scroll attempt); the engine frame
// reports "status" (face, speech models, last phrase heard).
const toggle = document.getElementById("enabled");
// How easily a negative face scrolls; the Face row shows the live percentage.
const sensitivity = document.getElementById("face-sensitivity");
// Pause the Short while the camera cannot see a face.
const pauseWhenAway = document.getElementById("pause-when-away");
// Move on when the current Short finishes.
const scrollAtEnd = document.getElementById("scroll-at-end");
const summary = document.getElementById("summary");
const status = document.getElementById("status");
const fields = Object.fromEntries(["frame", "link", "microphone", "camera", "face", "speech", "heard", "scroll"]
  .map(id => [id, document.getElementById(id)]));
const FRAME = {
  loading: "starting…",
  loaded: "running",
  "did not load": "did not load (reload the page)",
  none: "off"
};
const SCROLL_REASONS = {
  "no-visible-short": "no Short video visible",
  "unsupported-page": "not a Shorts page",
  "no-scroll-container": "could not find the next Short",
  "end-of-feed": "end of the feed",
  cooldown: "waiting 3 s after the last scroll"
};
const LIVE_MS = 5000;

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds < 2 ? "just now" : `${seconds} s ago`;
}

function show({ enabled, faceSensitivity, pauseWhenAway: pause, scrollAtEnd: atEnd, page, status: engine }) {
  toggle.checked = enabled !== false;
  scrollAtEnd.checked = atEnd !== false;
  pauseWhenAway.checked = pause !== false;
  if (document.activeElement !== sensitivity) sensitivity.value = faceSensitivity || "medium";
  const live = toggle.checked && page && Date.now() - page.at < LIVE_MS;
  // The engine reports at least every 2 s; older means it stopped responding.
  const engineLive = live && engine && Date.now() - engine.at < LIVE_MS;

  status.hidden = !live;
  summary.textContent = !toggle.checked ? "Off. Turn on to scroll Shorts by your reactions."
    : live && page.paused ? "Paused: can't see your face. Look back to resume."
    : live ? "On. React to skip or keep watching."
    : "On. Open a YouTube Short (reload the tab if it was already open).";
  if (!live) return;

  fields.frame.textContent = page.frame !== "loaded" ? FRAME[page.frame] || page.frame
    : !engine ? "loaded, no report yet"
    : engineLive ? "running"
    : `not responding (last report ${ago(engine.at)})`;
  // Page → engine messages; if none arrive, no audio or camera frames reach it.
  const received = engine?.received;
  fields.link.textContent = `${page.link?.sent ?? 0} sent, ${received ? received.messages : "?"} received` +
    (received ? ` (${received.micPackets} audio, ${received.cameraFrames} camera)` : "") +
    (page.link?.error ? ` · error: ${page.link.error}` : "") +
    (page.link?.rewritten ? " · Safari rewrote the engine address" : "");
  fields.microphone.textContent = page.microphone + (engine ? ` · analysis: ${engine.microphone}` : "") +
    (engine?.audioError && engine.microphone !== "listening" ? ` (${engine.audioError}; restarting)` : "");
  fields.camera.textContent = page.camera;
  fields.face.textContent = engine ? engine.camera : "waiting for the engine";
  fields.speech.textContent = engine ? engine.speech?.models || "off" : "waiting for the engine";

  const heard = engine?.speech?.heard;
  fields.heard.textContent = !heard ? "nothing yet"
    : `“${heard.text || "…"}” → ${heard.signal}${heard.late ? " (too late, ignored)" : ""}, ${ago(heard.at)}`;

  const scroll = page.scroll;
  fields.scroll.textContent = !scroll ? "no scroll yet"
    : scroll.advanced ? `scrolled${scroll.detail === "video ended" ? " (video ended)" : ""} ${ago(scroll.at)}`
    : `not scrolled: ${SCROLL_REASONS[scroll.detail] || scroll.detail}, ${ago(scroll.at)}`;
}

async function refresh() {
  show(await browser.storage.local.get(["enabled", "faceSensitivity", "pauseWhenAway", "scrollAtEnd", "page", "status"]));
}

toggle.addEventListener("change", async () => {
  await browser.storage.local.set({ enabled: toggle.checked });
  refresh();
});

scrollAtEnd.addEventListener("change", () => {
  browser.storage.local.set({ scrollAtEnd: scrollAtEnd.checked });
});

pauseWhenAway.addEventListener("change", () => {
  browser.storage.local.set({ pauseWhenAway: pauseWhenAway.checked });
});

sensitivity.addEventListener("change", () => {
  browser.storage.local.set({ faceSensitivity: sensitivity.value });
});

browser.storage.onChanged.addListener(refresh);
setInterval(refresh, 1000);
refresh();
