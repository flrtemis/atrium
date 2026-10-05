#!/usr/bin/env python3

from pathlib import Path

import requests
from huggingface_hub import snapshot_download


OUTPUT_DIR = Path(__file__).resolve().parent / "models" / "qwen3-tts-gguf"
GGUF_FILES = {
    "qwen-talker-1.7b-customvoice-BF16.gguf": "https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/main/qwen-talker-1.7b-customvoice-BF16.gguf?download=1",
    "qwen-tokenizer-12hz-BF16.gguf": "https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/main/qwen-tokenizer-12hz-BF16.gguf?download=1",
}


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".part")
    existing = tmp.stat().st_size if tmp.exists() else 0
    headers = {"Range": f"bytes={existing}-"} if existing else {}
    with requests.get(url, stream=True, timeout=60, headers=headers) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length", "0"))
        if response.status_code == 206:
            total += existing
        elif existing:
            tmp.unlink()
            existing = 0
        written = existing
        next_report = 256 * 1024 * 1024
        while written >= next_report:
            next_report += 256 * 1024 * 1024
        with tmp.open("ab" if existing else "wb") as handle:
            for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                if not chunk:
                    continue
                handle.write(chunk)
                written += len(chunk)
                if written >= next_report:
                    if total:
                        print(f"{destination.name}: {written / 1024**3:.2f} / {total / 1024**3:.2f} GiB")
                    else:
                        print(f"{destination.name}: {written / 1024**3:.2f} GiB")
                    next_report += 256 * 1024 * 1024
    tmp.replace(destination)


def main() -> None:
    print("Downloading Qwen3-TTS HF model cache...")
    snapshot_download("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
    for filename, url in GGUF_FILES.items():
        destination = OUTPUT_DIR / filename
        if destination.is_file() and destination.stat().st_size > 0:
            print(f"{filename}: already present")
            continue
        print(f"Downloading {filename}...")
        download_file(url, destination)
    print("Done")


if __name__ == "__main__":
    main()