# AutoScroll

Safari extension for reaction-controlled Shorts and Reels navigation.

## Audio reactions

`AutoScroll/Shared (Extension)/Resources/audio.js` handles microphone permission,
mono capture, resampling, pretrained model inference, and reaction classification.
Its signal callback receives **only** `"positive"`, `"negative"`, or `"neutral"`.
Microphone lifecycle and errors use separate callbacks, so a denied microphone is
not silently reported as a neutral reaction.

```js
import { createAudioDetector } from './audio.js';

const audio = createAudioDetector({
    onSignal(signal) {
        // Pass this label to decision.js when that module is ready.
        console.log(signal);
    },
    onError(error) { console.error(error.message); }
});

startButton.addEventListener('click', () => {
    audio.start().catch(console.error);
});
stopButton.addEventListener('click', () => { audio.stop(); });
window.addEventListener('pagehide', () => { audio.stop(); });
```

Use this module in a persistent page such as the audio test tab, not a closing
extension popup or a background script. `start()` must run from a user gesture.
The test page does not call `AutoScroll.next()`; combining audio/camera signals,
skip decisions, and scroll cooldowns belong in the future `decision.js`.

### Try it

1. Run **AutoScroll (macOS)** on **My Mac** in Xcode.
2. Enable the extension in Safari (allow unsigned extensions for local builds).
3. Click its toolbar icon, then **Test microphone**.
4. In the new tab, click **Start listening** and allow microphone access.
5. Try laughing or groaning; watch the label. Click **Stop** to release the mic.

Keep the test tab open while listening. Safari may interrupt capture; the page
reports an error and requires Start again instead of retaining an old reaction.
Use headphones: echo cancellation does not reliably exclude audio from another
tab, so video playback can otherwise be mistaken for your reaction. No audio is
saved or uploaded. Model/runtime files are bundled locally.

If Safari blocks microphone capture in an extension page, test the same files
from a local secure-context origin. From the repository root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory 'AutoScroll/Shared (Extension)/Resources'
```

Open `http://localhost:8765/audio.html` in Safari and click Start. Stop the server
with Ctrl+C when finished. This tests audio only; it does not connect localhost
to the extension's scrolling. Safari microphone capture needs a manual check on
the user's browser; a successful Xcode build does not verify permissions.

### Model and label rules

This version uses **[Google YAMNet TFJS v1](https://www.kaggle.com/models/google/yamnet)**
and TensorFlow.js 4.22.0 (ES2017 build, compatible with extension script security). YAMNet predicts 521 AudioSet sound classes, not emotions
or spoken sentiment. We interpret a subset of those sound classes as reactions:

- Positive: laughter, giggling, snickering, belly laughter, chuckling.
- Negative: crying/sobbing, whimpering, wailing/moaning, groaning.
- Neutral: silence, ordinary speech, other sounds, low scores, or ambiguous evidence.

These are app heuristics, not proof of enjoyment/dislike. A laugh may be sarcastic;
a groan may be playful. Spoken phrases like “skip this” are not understood yet.

The module collects one second of mono PCM, resamples to 16 kHz using the browser's
audio resampler, and averages each class's scores across the model's frames.
It takes the strongest class score per reaction group, requires at least 0.35,
and a 0.15 margin over the opposite group; otherwise it returns neutral.
RMS below 0.008 is treated as silence. These starting thresholds need tuning on
real microphones; model scores are not calibrated probabilities. The constants
live at the top of `audio.js`. Model windows are dropped while inference is busy
to avoid a backlog. No skip cooldown is applied here.

The separate `audio-worklet.js` only collects PCM and outputs silence to prevent
microphone feedback. All model and reaction calculations remain in `audio.js`.
The demo's Stop button, page close, mic disconnection, and inference errors release
the stream. Late permission grants and late inference results are discarded.

### Bundled assets and verification

`Resources/audio-assets/` contains the pinned runtime, official pretrained model
weights, class map, Apache 2.0 licenses, and source/checksum receipts in
`SOURCES.json` (about 17.6 MB total). Both Xcode extension targets include the folder.
No npm install, API key, training, or runtime model download is required.

To restore the exact downloaded assets, with Node.js 20+ and network access:

```sh
node scripts/setup-audio.mjs
```

Run the automated tests:

```sh
node --experimental-vm-modules --test tests/*.test.cjs
```

References: [official class map](https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv),
[YAMNet documentation](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet),
[Web Audio worklets](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode).
