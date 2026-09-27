# AutoScroll

Safari extension that scrolls YouTube Shorts for you, based on your reactions.
Everything runs on your Mac: no video or audio is recorded, uploaded, or sent to
any service.

## How it works

1. **On/off.** Click the AutoScroll icon in Safari's toolbar and use the switch. It
   is on by default and the setting is remembered. The popup also shows live
   status: camera, microphone, and the last decision.
2. **Hidden engine.** On a YouTube Shorts page, `extension-interaction.js` adds an
   invisible extension frame (`engine.html`) that runs the models. Leaving Shorts
   or turning AutoScroll off removes it and stops the camera and microphone.
3. **Camera and microphone.** The YouTube page captures both (Safari asks
   youtube.com for the microphone, then the camera) and streams them into the
   frame: framed audio from `audio-worklet.js`, and about 6 small camera frames a
   second. Two Safari rules require this: a hidden frame from another site cannot
   start audio without a click inside it, and when a second site in the same tab
   starts capturing, Safari mutes the first. Denying the camera leaves the
   microphone working (and the reverse). If Safari holds audio back, it starts on
   your next click or key press on the page.
4. **Decide.** Twice a second, `decide()` in `decision.js` turns your face
   expression and what you say (plus laughs and groans) into **scroll**, **watch**,
   or no reading. A spoken or vocal reaction overrides the face for 3 s. For the
   face, the probabilities of the negative expressions (sad, angry, disgusted,
   fearful, contemptuous) are added up and averaged over 1.5 s; it scrolls when
   that share reaches the **Face sensitivity** threshold chosen in the popup (Low
   25%, Medium 15% (default), High 10%) and outweighs happy and surprised. The
   popup's Face row shows the live share, e.g. "12% negative (scrolls at 15%)".
   A face reading older than 1 s is dropped, so a stale expression never decides.
5. **Pause when away.** If the camera sees no face looking at it for 0.5 s (you
   left, or turned your head), the Short pauses with a small "Paused" notice, and
   resumes when you look back. A head turn is measured from the face detector's
   eye and nose points (the nose's offset from between the eyes); past 35% the
   face counts as looking away and is not scored, because side views read as
   disgust or contempt and would otherwise scroll. The popup's Face row shows the
   live turn. Only a video AutoScroll paused is resumed; your own pause or play
   wins. It never pauses without a working camera. Switch it off in the popup.
6. **Next Short at the end.** When a playing Short reaches its last ~0.35 s (or
   loops back to its start), AutoScroll moves to the next one, once per
   playthrough. A paused Short never advances. Uses the normal 3-second scroll
   cooldown; switch it off in the popup ("Scroll when a Short ends").
7. **Pop-up.** When it first sees your face or hears you, a small "AutoScroll is on"
   notice appears in the top-right corner for a few seconds.
8. **Scroll.** On "scroll", the page moves to the next Short, then waits at least
   3 seconds before scrolling again.

Frame and page messages carry a random token from the frame's URL. Instagram Reels
are not supported: Instagram blocks the camera and microphone in embedded frames.
Manual skip: Option + Shift + Down arrow. Note: allowing the camera and microphone for
youtube.com also lets YouTube's own scripts use them without asking again; you can
revoke them in Safari > Settings > Websites > Camera / Microphone.

## Audio reactions

`audio.js` reports **positive** or **negative** reactions; neutral is never sent.
`decision.js` uses it through `onSignal(signal, { source, transcript })`, called once
per new reaction. `listen({ timeoutMs })` is also available: it resolves with the
next reaction heard after the request, or `null`. Every spoken phrase is a new
reaction; a laugh that keeps going is one reaction.

### How it decides

Two detectors produce **reaction events**:

| Detector | Listens for | Positive | Negative |
|---|---|---|---|
| **Words** | Each spoken phrase, transcribed on-device, then scored for sentiment | "that's hilarious", "I love this", "keep this" | "this is so boring", "skip", "next", "ugh, gross" |
| **Sounds** (YAMNet) | Non-verbal vocal sounds | laughing, giggling, chuckling | groaning, sighing, grunting, crying, whimpering |

Each reaction is held for **3 seconds** as the current label. A neutral statement,
a pause, or starting to speak does not cut a held reaction short.

**Words.** The capture worklet finds phrases by loudness: a phrase needs at least
0.25 s of voice and ends after a 0.15 s pause (continuous speech is analyzed at
least every 4 s). A phrase is transcribed only if YAMNet heard a human voice during
it, because Whisper invents text for music and noise. Then:

1. [Whisper tiny.en](https://huggingface.co/openai/whisper-tiny.en) transcribes the phrase.
2. Transcripts that Whisper typically hallucinates ("Thank you.", "you",
   `[BLANK_AUDIO]`, `(music)`) are discarded. On music or singing, Whisper can
   loop ("la la la ..." up to 448 tokens, 7.5 s in WebKit), blocking new phrases;
   output is capped by clip length (about 8 tokens per second, at most 48), no
   3-token run may repeat, and no word is kept more than 3 times in a row.
3. [Twitter RoBERTa sentiment](https://huggingface.co/cardiffnlp/twitter-roberta-base-sentiment-latest),
   trained on short informal posts, scores positive / neutral / negative.
4. Positive or negative wins with a score of at least **0.5** and a **0.2** lead
   over the runner-up. Otherwise a short app keyword list decides ("skip", "next",
   "boring", "ugh", "cringe" → negative; "keep", "love", "lol", "funny" → positive).
   Negation is handled: "not funny" is negative and "don't skip" is ignored.

The rules are in `speech-core.js`. Only the newest phrase waits while one is being
analyzed. Results arriving more than 8 s after their phrase are dropped.

**Sounds.** YAMNet analyzes overlapping 975 ms windows every 240 ms. A reaction
sound counts when its class is the strongest sound, or when it scores at least
**0.15** and at least **40%** of the strongest sound (a groan over speech). It must
appear in **two consecutive windows** (about 0.5 s) before it becomes an event, so
one stray frame is ignored. Quiet audible input is amplified toward about −26 dBFS
(at most 32×); near-silence (RMS below 0.001) is never classified.

### Measured accuracy and speed

On 120 synthesized statements (30 phrases × 4 macOS voices: 10 positive, 10
negative, 10 neutral) the word pipeline labelled **119/120** correctly. The one
miss was "Boring, skip it", which Whisper heard as "Bory Skippert". Synthesized
speech is clearer than a real room, so expect lower accuracy live.

Whisper's encoder always processes a padded 30-second block, which is most of
the work. When the Mac's GPU is available (WebGPU), the encoder runs there:

| Measured in WebKit on this Mac | GPU (default) | CPU (fallback) |
|---|---|---|
| Transcribe one phrase | about **0.46 s** | about 1.55 s |
| Score sentiment | 0.07 s | 0.07 s |
| Result after you stop talking (incl. 0.15 s pause) | about **0.7 s** | about 1.8 s |
| First Start (load models) | about 1.8 s | about 1.3 s |
| Start again on the same page | about 0.15 s | about 1.3 s |

Laughs and groans register in about 0.5 s either way. If the GPU is missing or
fails to load, the CPU is used automatically.

GPU mode runs on the page thread, which pauses the page for up to about 0.17 s
per phrase; microphone capture continues on its own thread. It can't use a
worker, because terminating a worker that used WebGPU crashes the page in WebKit,
including when the frame is removed. So GPU models stay loaded until the frame is
removed. The CPU mode keeps its worker and frees it when the microphone stops.
These timings come from Playwright's WebKit build; confirm them in Safari itself.

**Limits:** sarcasm is not detected; only English is supported; speech from the
video is transcribed too unless you use headphones.

### Try it

1. Run **AutoScroll (macOS)** on **My Mac** in Xcode.
2. Enable the extension in Safari (allow unsigned extensions for local builds) and
   allow it on youtube.com.
3. Open a YouTube Short. Reload tabs that were open before the extension loaded.
4. Allow camera and microphone access.
5. When "AutoScroll is on" pops up, react: say "ugh, skip this" or frown to move on;
   laugh or say "that's hilarious" to keep watching.

If nothing scrolls, say something negative, then open the toolbar popup. It shows
each step: **Engine**, **Link** (messages from the page that reached the engine),
**Microphone**, and **Camera** (including Safari's error, if any), **Face** (models loaded, face seen), **Speech** (models loaded), **Heard** (the
last phrase transcribed and how it was scored), and **Scroll** (the last scroll
attempt, or why it did not scroll). Use headphones,
so speech from the video is not mistaken for yours.

### Files

- `popup.html` / `popup.js` / `popup.css`: toolbar popup with the on/off switch and live status.
- `extension-interaction.js`: in YouTube tabs. Adds the hidden engine frame on Shorts, captures the microphone and camera for it, scrolls on "scroll" (3-second cooldown) and when a Short ends, pauses while you are away, shows the pop-up.
- `engine.html` / `engine.js` / `engine.css`: the hidden engine; takes the page's audio and camera frames, posts a decision twice a second.
- `decision.js`: `decide()`; combines face and audio.
- `facialExpressionClassifier.js`: face detection (BlazeFace) and expression (FER+), from its own camera or from frames passed to `pushFrame()`.
- `audio-worklet.js`: frames mono PCM into YAMNet windows and phrases; runs as an AudioWorklet or, in YouTube tabs, as a content script (`AutoScrollFramer`).
- `audio.js`: YAMNet, reaction events, and microphone lifecycle.
- `speech.js`: picks GPU (page thread) or CPU (`speech-worker.js`) and queues phrases.
- `speech-models.js`: loads Whisper and the sentiment model via Transformers.js; used by both modes.
- `speech-core.js`: transcript cleanup, sentiment gate, and keywords.

### Bundled assets and verification

- `Resources/audio-assets/` (about 17.6 MB): YAMNet and TensorFlow.js 4.22.0.
- `Resources/speech-assets/` (about 220 MB):
  - Transformers.js 4.3.0 and its ONNX Runtime WebAssembly build.
  - Whisper tiny.en, Apache-2.0: 8-bit quantized, plus a full-precision encoder for GPU mode.
  - Twitter RoBERTa sentiment, 8-bit quantized ONNX conversion by Xenova, **CC BY 4.0**.
    Credit: Loureiro et al., *TimeLMs*, Cardiff NLP (2022). The model card is included.

Everything needed is committed, so a fresh clone builds in Xcode with no setup
step. No models are downloaded at runtime. Both Xcode extension targets include
both folders, and the extension's CSP allows local WebAssembly.

Each folder's `SOURCES.json` lists every file's source URL, pinned revision, and
SHA-256, and the tests check that every bundled file matches. Two speech files are
lightly modified from their downloads so that GitHub accepts them (the original
URL and hash are recorded under `derivedFrom`):

- The sentiment model's 126 MB weight file, over GitHub's 100 MB limit, is stored
  as a 0.5 MB graph plus three weight chunks under 50 MB each. The weights are
  byte-identical and scores match the original exactly.
- In `transformers.min.js`, the unused class name `Mistral3ForConditionalGeneration`
  is renamed to `Mistral3ForCondGeneration`. GitHub's secret scanning mistakes the
  original name for a Mistral API key and blocks the push. Only Mistral 3 model
  support, which this app does not use, is affected.

To re-download the YAMNet assets (optional; they are committed):

```sh
node scripts/setup-audio.mjs
```

Run the automated tests:

```sh
node --experimental-vm-modules --test tests/*.test.cjs
```

To check the speech worker in a real browser without a microphone, serve the
repository root with `python3 -m http.server 8766 --bind 127.0.0.1` and open
`http://127.0.0.1:8766/tests/speech-browser.html`. It transcribes and scores three
recorded statements and prints PASS or FAIL with timings.

References: [YAMNet class map](https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv),
[YAMNet documentation](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet),
[Transformers.js](https://huggingface.co/docs/transformers.js),
[Web Audio worklets](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode).
