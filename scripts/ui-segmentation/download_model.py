"""Download only the image checkpoint and processor configs, into one location."""
import os
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".local/ui-segmentation"
os.environ["HF_HOME"] = str(RUNTIME / "download-cache")
os.environ["HF_HUB_DISABLE_XET"] = "1"

from huggingface_hub import snapshot_download

repo_id = "facebook/sam2.1-hiera-tiny"
revision = "de431c4043854a71d8101e17995dfe596bf101a5"

snapshot_download(
    repo_id=repo_id,
    revision=revision,
    local_dir=RUNTIME / "model",
    allow_patterns=["model.safetensors", "config.json", "preprocessor_config.json", "processor_config.json", "README.md"],
)
(RUNTIME / "model-source.json").write_text(json.dumps({"repo": repo_id, "revision": revision}, indent=2))
print("Installed one SAM 2.1 Tiny checkpoint:", RUNTIME / "model")
