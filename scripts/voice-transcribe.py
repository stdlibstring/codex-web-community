import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel
from voice_audio import decode_recording, prepare_audio
from voice_text import simplify_transcript

root = Path(__file__).resolve().parents[1]
data = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
if not data or len(data) > 16 * 1024 * 1024:
    raise ValueError("录音文件大小需要处于 1 字节到 16 MiB 之间。")
audio = prepare_audio(decode_recording(data))
model = WhisperModel(
    str(root / ".artifacts/voice-model"),
    device="cpu",
    compute_type="int8",
    cpu_threads=8,
    num_workers=1,
    local_files_only=True,
)
segments, info = model.transcribe(
    audio,
    beam_size=5,
    vad_filter=True,
    condition_on_previous_text=False,
)
text = simplify_transcript("".join(segment.text for segment in segments).strip())
print(json.dumps({"text": text, "language": info.language}, ensure_ascii=False))
