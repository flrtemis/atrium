#!/usr/bin/env python3
"""Download the optional tracking models Atrium's eyes can use.

Atrium works without this: with no models installed it falls back to
frame-difference motion tracking, which still answers "are you there?" and
"which way did you move?", and the language model can still read real camera
frames. What this script adds is the precise layer — hand landmarks (so finger
counting is exact and instant), body pose, and face landmarks.

Everything lands under public/vendor/mediapipe/, which the Bun server serves
at /vendor/mediapipe/. Nothing here is imported at build time; the browser
fetches it on demand, so a missing file only ever costs a feature, never a boot.

    python3 download_vision_assets.py              # everything
    python3 download_vision_assets.py --only hands # just finger counting
    python3 download_vision_assets.py --cdn        # force the CDN mirror
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

OUTPUT_DIR = Path(__file__).resolve().parent / "public" / "vendor" / "mediapipe"
WASM_DIR = OUTPUT_DIR / "wasm"
MODEL_DIR = OUTPUT_DIR / "models"

NPM_PACKAGE = "@mediapipe/tasks-vision"
NPM_VERSION = "1.0.1"
JSDELIVR_BASE = f"https://cdn.jsdelivr.net/npm/{NPM_PACKAGE}@{NPM_VERSION}"
NPM_REGISTRY = "https://registry.npmjs.org"

# The runtime: one ES module plus the wasm pair (SIMD + no-SIMD + module build).
RUNTIME_FILES = [
    "vision_bundle.mjs",
    "wasm/vision_wasm_internal.js",
    "wasm/vision_wasm_internal.wasm",
    "wasm/vision_wasm_nosimd_internal.js",
    "wasm/vision_wasm_nosimd_internal.wasm",
    "wasm/vision_wasm_module_internal.js",
    "wasm/vision_wasm_module_internal.wasm",
]

# The models. hand_landmarker is the one that makes finger counting exact.
MODELS = {
    "hands": (
        "hand_landmarker.task",
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    ),
    "pose": (
        "pose_landmarker_lite.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    ),
    "face": (
        "face_landmarker.task",
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    ),
}


def _report(name: str, written: int, total: int) -> None:
    if total:
        pct = 100.0 * written / total
        print(f"\r  {name}: {written / 1024 ** 2:.1f} / {total / 1024 ** 2:.1f} MiB ({pct:.0f}%)", end="", flush=True)
    else:
        print(f"\r  {name}: {written / 1024 ** 2:.1f} MiB", end="", flush=True)


def download_file(url: str, destination: Path, label: str | None = None) -> bool:
    """Stream `url` to `destination`. Returns True if the file is there after."""
    name = label or destination.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".part")

    existing = tmp.stat().st_size if tmp.exists() else 0
    request = urllib.request.Request(url)
    if existing:
        request.add_header("Range", f"bytes={existing}-")

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            if response.status == 206:
                total = int(response.headers.get("content-range", "/0").split("/")[-1] or 0)
            else:
                total = int(response.headers.get("content-length", "0") or 0)
                existing = 0
            mode = "ab" if existing else "wb"
            written = existing
            with tmp.open(mode) as handle:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    written += len(chunk)
                    _report(name, written, total)
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        print(f"\r  {name}: FAILED ({exc})")
        return False

    print()
    tmp.replace(destination)
    print(f"  {name}: ok ({destination.stat().st_size / 1024 ** 2:.2f} MiB)")
    return True


def runtime_from_jsdelivr() -> bool:
    print("Downloading MediaPipe runtime from jsDelivr…")
    ok = True
    for rel in RUNTIME_FILES:
        dest = OUTPUT_DIR / rel
        if dest.is_file() and dest.stat().st_size > 0:
            print(f"  {rel}: already present")
            continue
        if not download_file(f"{JSDELIVR_BASE}/{rel}", dest, rel):
            ok = False
    return ok


def runtime_from_npm() -> bool:
    """Fallback: pull the published tarball straight from the npm registry.

    Slower (one ~10 MB archive) but it only depends on the registry, which is
    reachable from far more networks than any CDN.
    """
    print("Downloading MediaPipe runtime from the npm registry…")
    try:
        with urllib.request.urlopen(f"{NPM_REGISTRY}/{NPM_PACKAGE}/{NPM_VERSION}", timeout=60) as response:
            meta = json.load(response)
        tarball = meta.get("dist", {}).get("tarball")
        if not tarball:
            print("  registry metadata has no tarball")
            return False
        with urllib.request.urlopen(tarball, timeout=300) as response:
            payload = response.read()
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"  registry download failed: {exc}")
        return False

    WASM_DIR.mkdir(parents=True, exist_ok=True)
    count = 0
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            name = member.name.split("/", 1)[-1]
            if name not in RUNTIME_FILES and not name.startswith("wasm/"):
                continue
            if name not in RUNTIME_FILES:
                continue
            dest = OUTPUT_DIR / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as src, dest.open("wb") as dst:
                dst.write(src.read())
            print(f"  {name}: ok ({dest.stat().st_size / 1024 ** 2:.2f} MiB)")
            count += 1
    return count > 0


def runtime_present() -> bool:
    return all((OUTPUT_DIR / rel).is_file() for rel in RUNTIME_FILES)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--only",
        choices=sorted(MODELS),
        help="download a single model instead of all three",
    )
    parser.add_argument("--cdn", action="store_true", help="skip the jsDelivr mirror check, go straight to npm")
    parser.add_argument("--models-only", action="store_true", help="only fetch the .task models")
    args = parser.parse_args()

    print(f"Installing Atrium vision assets into {OUTPUT_DIR}")
    print("(optional — Atrium runs without these, using motion tracking only)\n")

    if not args.models_only and not runtime_present():
        ok = runtime_from_npm() if args.cdn else runtime_from_jsdelivr()
        if not ok and not runtime_present():
            print("\njsDelivr was unreachable — retrying via the npm registry…")
            if not runtime_from_npm():
                print(
                    "\nCould not download the MediaPipe runtime.\n"
                    "Atrium will still run with motion tracking; only precise hand,\n"
                    "body and face tracking will be missing."
                )

    wanted = [args.only] if args.only else sorted(MODELS)
    print("\nDownloading landmark models…")
    for key in wanted:
        filename, url = MODELS[key]
        dest = MODEL_DIR / filename
        if dest.is_file() and dest.stat().st_size > 0:
            print(f"  {filename}: already present")
            continue
        if not download_file(url, dest, f"{key} ({filename})"):
            print(f"  {filename}: skipped — {key} tracking will be unavailable")

    print("\nDone. Restart Atrium and open /lab to check the tracking.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
