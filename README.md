# AutoScroll

Safari extension for reaction-controlled Shorts and Reels navigation.

## Audio reactions

`AutoScroll/Shared (Extension)/Resources/audio.js` listens to the microphone and
tells the future `decision.js` whether you reacted **positively** or **negatively**.
Neutral is never sent: if you don't react, nothing is reported. Everything runs on
your Mac. No audio is recorded, uploaded, or sent to any service.

```js
import { createAudioDetector } from './audio.js';

const audio = createAudioDetector({ onError(error) { console.error(error.message); } });

startButton.addEventListener('click', () => { audio.start().catch(console.error); });
stopButton.addEventListener('click', () => { audio.stop(); });
window.addEventListener('pagehide', () => { audio.stop(); });

// In decision.js: ask for the next reaction, e.g. when a new video starts.
const reaction = await audio.listen({ timeoutMs: 5000 });
if (reaction === 'negative') { /* skip */ }
if (reaction === 'positive') { /* keep watching */ }
if (reaction === null) { /* no reaction within 5 s: nothing was sent */ }
```

`listen({ timeoutMs = 5000, signal })` resolves with the **next** positive or
negative reaction heard **after** the request; a reaction from before the request
does not count. It resolves `null` on timeout, when the optional `AbortSignal`
aborts, or when the microphone stops. It rejects if the microphone was never
started. Several requests may wait at once; one reaction answers them all.
`timeoutMs: Infinity` waits until a reaction or stop.

To react to everything instead of asking, pass `onSignal(signal, { source,
transcript })`. It is called once per new reaction, never with neutral. `source` is
`"words"` or `"sound"`. Every spoken phrase is a new reaction, even two negative
phrases in a row; a laugh that keeps going is one reaction.

Use it in a persistent page such as the audio test tab, not a popup or background
script. `start()` must run from a user gesture. `start({ deviceId, processing: false })`
selects an exact microphone and asks for input without echo cancellation, noise
suppression, or automatic gain. Skip decisions and scroll cooldowns belong in the
future `decision.js`; the test page never scrolls.

### How it decides

Two detectors produce **reaction events**:

| Detector | Listens for | Positive | Negative |
|---|---|---|---|
| **Words** | Each spoken phrase, transcribed on-device, then scored for sentiment | "that's hilarious", "I love this", "keep this" | "this is so boring", "skip", "next", "ugh, gross" |
| **Sounds** (YAMNet) | Non-verbal vocal sounds | laughing, giggling, chuckling | groaning, sighing, grunting, crying, whimpering |

The newest non-neutral event sets the output and holds it for **3 seconds**, then
the output returns to neutral. A neutral statement, a pause, or starting to speak
does not cut a held reaction short, so the label does not flicker. `onSignal` is
called only when the label changes.

**Words.** The capture worklet finds phrases by loudness: a phrase needs at least
0.25 s of voice and ends after a 0.15 s pause (continuous speech is analyzed at
least every 4 s). A phrase is transcribed only if YAMNet heard a human voice during
it, because Whisper invents text for music and noise. Then:

1. [Whisper tiny.en](https://huggingface.co/openai/whisper-tiny.en) transcribes the phrase.
2. Transcripts that Whisper typically hallucinates ("Thank you.", "you",
   `[BLANK_AUDIO]`, `(music)`) are discarded.
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

Laughs and groans register in about 0.5 s either way. The demo page shows which
one is in use. If the GPU is missing or fails to load, the CPU is used automatically.

GPU mode runs on the page thread, which pauses the page for up to about 0.17 s
per phrase; microphone capture continues on its own thread. It can't use a
worker, because terminating a worker that used WebGPU crashes the page in WebKit,
including on Stop, tab close, and navigation. So GPU models stay loaded until the
page closes, which also makes restarting quick. The CPU mode keeps its worker and
frees it on Stop. These timings come from Playwright's WebKit build; confirm them in
Safari itself.

**Limits:** sarcasm is not detected; only English is supported; speech from the
video is transcribed too unless you use headphones.

### Try it

1. Run **AutoScroll (macOS)** on **My Mac** in Xcode.
2. Enable the extension in Safari (allow unsigned extensions for local builds).
3. Click its toolbar icon, then **Test microphone**.
4. Click **Start listening** and allow microphone access. If the system default
   microphone is wrong, Stop, choose it in the selector, and Start again.
5. Say something short and pause: "that's hilarious", "ugh, skip this",
   "I'll be right back". The page shows what it heard, the sentiment scores, and
   the label. Laughing or groaning also works. **Listen once (5 s)** makes the same
   request `decision.js` will and shows the result it would receive. Click **Stop**
   to release the mic.

The microphone meter updates about ten times per second, independently of the
models. If the macOS Sound input meter moves but this one does not, select the same
device explicitly. With headphones on, try disabling **Reduce speaker echo and
background noise** and restarting. Microphone and processing changes require Stop.

If Safari blocks microphone capture in an extension page, serve the same files
from localhost. From the repository root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory 'AutoScroll/Shared (Extension)/Resources'
```

Open `http://localhost:8765/audio.html` in Safari and click Start. This tests audio
only; it is not connected to scrolling.

### Callbacks

- `listen()` / `onSignal(signal, detail)`: decision input, positive or negative only (see above).
- `onLabel(label)`: the held label for display, including neutral. Each reaction is
  held for 3 seconds, then it returns to neutral. `getSignal()` returns the same label.
- `onSpeech(status)`: `loading`, `listening`, `hearing`, `transcribing`,
  `result` (with `transcript`, `signal`, `reason`, `scores`, timings), `unavailable`,
  or `disabled`. If the speech models fail, sound reactions keep working.
- `onDiagnostics(data)`: YAMNet's strongest sound and scores, plus `source`
  (`words` or `sound`) of the active reaction.
- `onInput(level)`: live microphone level for the meter.

Pass `loadSpeechClassifier: null` for sounds only. Safari may interrupt capture;
the page then reports an error and requires Start again.

### Files

- `audio-worklet.js`: captures mono PCM, emits YAMNet windows and phrases, outputs silence (no feedback).
- `audio.js`: YAMNet, the event/hold logic, and microphone lifecycle.
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
