import json
from pathlib import Path

from huggingface_hub import snapshot_download

root = Path(__file__).resolve().parents[1]
model_id = "dropbox-dash/faster-whisper-large-v3-turbo"
revision = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
destination = root / ".artifacts/voice-model"
snapshot_download(
    model_id,
    revision=revision,
    local_dir=destination,
    allow_patterns=["config.json", "model.bin", "tokenizer.json", "preprocessor_config.json", "vocabulary.*"],
)
(destination / "source.json").write_text(
    json.dumps({"model": model_id, "revision": revision}, indent=2) + "\n"
)
print(destination)
