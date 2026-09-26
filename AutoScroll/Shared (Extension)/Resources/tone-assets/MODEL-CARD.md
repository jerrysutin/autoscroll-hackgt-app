---
language: en
tags:
- audio
- speech
- emotion-recognition
- wav2vec2
- audio-classification
datasets:
- TESS
- CREMA-D
- SAVEE
- RAVDESS
license: mit
metrics:
- accuracy
- f1
library_name: transformers.js
pipeline_tag: audio-classification
base_model:
- Dpngtm/wav2vec2-emotion-recognition
---



# wav2vec2-emotion-recognition (ONNX)


This is an ONNX version of [Dpngtm/wav2vec2-emotion-recognition](https://huggingface.co/Dpngtm/wav2vec2-emotion-recognition). It was automatically converted and uploaded using [this Hugging Face Space](https://huggingface.co/spaces/onnx-community/convert-to-onnx).


## Usage with Transformers.js


See the pipeline documentation for `audio-classification`: https://huggingface.co/docs/transformers.js/api/pipelines#module_pipelines.AudioClassificationPipeline


---


# wav2vec2-emotion-recognition (Robust Fine-Tuning)

This model is a fine-tuned version of [facebook/wav2vec2-base-960h](https://huggingface.co/facebook/wav2vec2-base-960h) for **Speech Emotion Recognition (SER)**. 

It has been trained using a **Frozen Feature Extractor** strategy to preserve the model's acoustic understanding while adapting to emotion detection. This approach ensures stable performance and prevents "Catastrophic Forgetting," achieving nearly **80% accuracy** on the validation set.

**Update:** The "Calm" and "Neutral" classes have been merged to improve classification consistency, resulting in **7 distinct emotion classes**.

## Model Description

- **Model Architecture:** Wav2Vec2 with a frozen CNN feature extractor and a trainable sequence classification head.
- **Language:** English
- **Task:** Speech Emotion Recognition (SER)
- **Fine-tuned from:** `facebook/wav2vec2-base-960h`
- **Class Merging:** The "Calm" emotion has been merged into "Neutral" to reduce label ambiguity.

### Datasets
The model was trained on a combined dataset of ~12,000 audio files from:
- [TESS](https://www.kaggle.com/datasets/ejlok1/toronto-emotional-speech-set-tess)
- [CREMA-D](https://www.kaggle.com/datasets/ejlok1/cremad)
- [SAVEE](https://www.kaggle.com/datasets/barelydedicated/savee-database)
- [RAVDESS](https://www.kaggle.com/datasets/uwrfkaggler/ravdess-emotional-speech-audio)

## Performance Metrics

| Metric | Score |
| :--- | :--- |
| **Accuracy** | **79.94%** |
| **F1 Score** | **79.65%** |
| **Validation Loss** | **0.644** |

> *Note: Achieved stable convergence using a Cosine Learning Rate Scheduler and Frozen Feature Extractor.*

## Supported Emotions (7 Classes)
The model classifies audio into one of the following emotions:

1. 😠 **Angry**
2. 🤢 **Disgust**
3. 😨 **Fear**
4. 😊 **Happy**
5. 😐 **Neutral** (includes Calm)
6. 😢 **Sad**
7. 😲 **Surprise**

## Training Configuration

The model was fine-tuned using the following "Robust" configuration to ensure stability on Google Colab T4 GPUs:

- **Feature Extractor:** **FROZEN** (Locked weights to preserve pre-trained acoustic features)
- **Epochs:** 10
- **Learning Rate:** 3e-5
- **Scheduler:** Cosine Decay (Smooth landing)
- **Batch Size:** 4 (Physical) / 16 (Effective via Gradient Accumulation)
- **Optimizer:** AdamW
- **Precision:** fp32 (Standard precision to prevent gradient underflow)

## Limitations

### Audio Requirements:
- **Sampling Rate:** 16kHz (Model will hallucinate if input is not 16kHz. Resampling is required.)
- **Duration:** < 10 seconds recommended (Longer files should be chunked).
- **Environment:** Best results with clear speech; background noise may reduce confidence.

## Demo
Try the model in your browser:
👉 **[Hugging Face Space: Audio Emotion Recognition](https://huggingface.co/spaces/Dpngtm/Audio-Emotion-Recognition)**
## FINETUNING NOTEBOOOKS
[Notebook](https://github.com/DGautam11/Speech-Emotion-Recognition/tree/main/notebooks)

## Contact
* **GitHub**: [DGautam11](https://github.com/DGautam11)
* **LinkedIn**: [Deepan Gautam](https://www.linkedin.com/in/deepan-gautam)  
* **Hugging Face**: [@Dpngtm](https://huggingface.co/Dpngtm)

For issues and questions, feel free to:
1. Open an issue on the [Model Repository](https://huggingface.co/Dpngtm/wav2vec2-emotion-recognition)
2. Comment on the [Demo Space](https://huggingface.co/spaces/Dpngtm/Audio-Emotion-Recognition)

## Usage

```python
from transformers import AutoModelForAudioClassification, Wav2Vec2Processor
import torch
import torchaudio
import numpy as np

# 1. Load Model and Processor
model_id = "Dpngtm/wav2vec2-emotion-recognition"
model = AutoModelForAudioClassification.from_pretrained(model_id)
processor = Wav2Vec2Processor.from_pretrained(model_id)

# 2. Load Audio
# Replace with your file path
audio_path = "path_to_audio.wav" 
speech_array, sampling_rate = torchaudio.load(audio_path)

# 3. Resample to 16kHz (CRITICAL STEP)
if sampling_rate != 16000:
    resampler = torchaudio.transforms.Resample(sampling_rate, 16000)
    speech_array = resampler(speech_array)
    sampling_rate = 16000

# 4. Handle Stereo (Convert to Mono)
if speech_array.shape[0] > 1:
    speech_array = torch.mean(speech_array, dim=0, keepdim=True)

# 5. Process & Predict
inputs = processor(speech_array.squeeze(), sampling_rate=16000, return_tensors="pt", padding=True)

with torch.no_grad():
    logits = model(**inputs).logits

# 6. Decode Result
predicted_id = torch.argmax(logits, dim=-1).item()
id2label = model.config.id2label
predicted_label = id2label[predicted_id]

print(f"Predicted Emotion: {predicted_label}")
