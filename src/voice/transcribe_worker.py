"""Speech to text for Wayfinder, on this machine only (audio never leaves it).

Reads one JSON object per line on stdin: {"id": "...", "path": "/tmp/....wav"} (16 kHz mono 16-bit WAV, which the
browser records directly, so no audio decoder library is needed)
Writes one per line on stdout:          {"id": "...", "text": "...", "ms": 812}
The model stays loaded between requests, so each one costs only the transcription itself.
"""
import json
import os
import sys
import time
import wave

import numpy as np
from faster_whisper import WhisperModel

MODEL = os.environ.get("WAYFINDER_STT_MODEL", "small.en")
# ServiceNow words Whisper otherwise mishears; the prompt nudges it toward them.
PROMPT = "ServiceNow, PDI, sys_id, GlideRecord, business rule, ACL, scoped app, Fluent, ATF, incident, CMDB, Flow Designer, update set, Pip."

model = WhisperModel(MODEL, device="cpu", compute_type="int8")
print(json.dumps({"ready": True, "model": MODEL}), flush=True)

for line in sys.stdin:
    try:
        req = json.loads(line)
        start = time.time()
        with wave.open(req["path"], "rb") as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                raise ValueError("expected 16-bit mono WAV")
            audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        segments, _ = model.transcribe(audio, language="en", beam_size=1, vad_filter=True, initial_prompt=PROMPT)
        text = " ".join(s.text.strip() for s in segments).strip()
        print(json.dumps({"id": req["id"], "text": text, "ms": int((time.time() - start) * 1000)}), flush=True)
    except Exception as e:  # one bad clip must not stop the worker
        print(json.dumps({"id": req.get("id") if isinstance(req, dict) else None, "error": str(e)}), flush=True)
