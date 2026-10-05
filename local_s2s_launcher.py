#!/usr/bin/env python3

import base64
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
from nano_parakeet import from_pretrained as load_nano_parakeet

from speech_to_speech.LLM.base_openai_compatible_language_model import BaseOpenAICompatibleHandler
from speech_to_speech.api.openai_realtime.service import RealtimeService


logger = logging.getLogger("local_s2s_launcher")
_VIDEO_AUDIO_STT_MODEL = None
_VIDEO_AUDIO_STT_UNAVAILABLE = False

# ── Atrium: camera-frame handling ─────────────────────────────────────────
# Atrium streams webcam frames into the conversation as `input_image` parts.
# Left alone they are whatever the browser encoded — easily 150 KB of base64
# each — which is more than a local model wants in its context, and more than a
# small one can hold at all. These knobs let a modest machine keep up.
#
#   ATRIUM_MAX_IMAGE_EDGE      downscale frames to this many pixels on the
#                              long edge (0 disables resizing)
#   ATRIUM_IMAGE_QUALITY       JPEG re-encode quality, 1-95
#   ATRIUM_MAX_IMAGES_PER_ITEM max frames kept from a single message
#   ATRIUM_STRIP_IMAGES        1 = drop images entirely and leave a text note,
#                              for models that cannot see (Atrium's landmark
#                              tracking still answers "how many fingers?")
_ATRIUM_MAX_IMAGE_EDGE = int(os.environ.get("ATRIUM_MAX_IMAGE_EDGE", "768") or 0)
_ATRIUM_IMAGE_QUALITY = int(os.environ.get("ATRIUM_IMAGE_QUALITY", "70") or 70)
_ATRIUM_MAX_IMAGES_PER_ITEM = int(os.environ.get("ATRIUM_MAX_IMAGES_PER_ITEM", "4") or 4)
_ATRIUM_STRIP_IMAGES = os.environ.get("ATRIUM_STRIP_IMAGES", "0").strip().lower() in {
    "1", "true", "yes", "on",
}


_ORIGINAL_SETUP = BaseOpenAICompatibleHandler.setup


def _patched_setup(self, *args, **kwargs):
    kwargs.setdefault("request_timeout_s", float(os.environ.get("LOCAL_LLM_REQUEST_TIMEOUT_S", "300")))
    return _ORIGINAL_SETUP(self, *args, **kwargs)


BaseOpenAICompatibleHandler.setup = _patched_setup


_ORIGINAL_PARSE_CLIENT_EVENT = RealtimeService.parse_client_event


@dataclass
class _DecodedUpload:
    filename: str
    mime_type: str
    data: bytes


def _strip_data_url_prefix(file_data: str) -> str:
    if file_data.startswith("data:") and "," in file_data:
        return file_data.split(",", 1)[1]
    return file_data


def _decode_upload_payload(part: dict[str, Any]) -> _DecodedUpload | None:
    filename = str(part.get("filename") or "upload")
    mime_type = str(part.get("mime_type") or "application/octet-stream")
    raw = part.get("file_data")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        data = base64.b64decode(_strip_data_url_prefix(raw), validate=False)
    except Exception:
        return None
    return _DecodedUpload(filename=filename, mime_type=mime_type, data=data)


def _workspace_tmp_dir() -> Path:
    root = Path(__file__).resolve().parent / ".runtime-tmp"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _video_audio_stt_model_candidates() -> list[str]:
    candidates: list[str] = []

    explicit = os.environ.get("VIDEO_AUDIO_STT_MODEL_NAME", "").strip()
    if explicit:
        candidates.append(explicit)

    extra = os.environ.get("VIDEO_AUDIO_STT_MODEL_CANDIDATES", "").strip()
    if extra:
        candidates.extend([x.strip() for x in extra.split(",") if x.strip()])

    # Match the STT handler default first (offline cache is likely already warm).
    candidates.extend([
        "nvidia/parakeet-tdt-0.6b-v3",
        "nvidia/parakeet-tdt-1.1b",
    ])

    deduped: list[str] = []
    seen = set()
    for name in candidates:
        if name not in seen:
            seen.add(name)
            deduped.append(name)
    return deduped


def _load_video_audio_stt_model():
    global _VIDEO_AUDIO_STT_MODEL
    global _VIDEO_AUDIO_STT_UNAVAILABLE
    if _VIDEO_AUDIO_STT_MODEL is not None:
        return _VIDEO_AUDIO_STT_MODEL
    if _VIDEO_AUDIO_STT_UNAVAILABLE:
        return None

    device = os.environ.get("VIDEO_AUDIO_STT_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
    for model_name in _video_audio_stt_model_candidates():
        try:
            logger.info("loading video-audio STT model: name=%s device=%s", model_name, device)
            _VIDEO_AUDIO_STT_MODEL = load_nano_parakeet(model_name=model_name, device=device)
            logger.info("video-audio STT model ready: name=%s", model_name)
            return _VIDEO_AUDIO_STT_MODEL
        except Exception as exc:
            logger.warning("video-audio STT model load failed: name=%s error=%s", model_name, exc)

    _VIDEO_AUDIO_STT_UNAVAILABLE = True
    logger.warning("video-audio STT unavailable: no candidate model could be loaded from local cache")
    return _VIDEO_AUDIO_STT_MODEL


def _video_to_frame_data_urls(upload: _DecodedUpload) -> list[str]:
    tmp_root = _workspace_tmp_dir()
    safe_name = Path(upload.filename).name or "upload_video"
    stem = Path(safe_name).stem or "upload_video"
    ext = Path(safe_name).suffix or ".bin"
    in_path = tmp_root / f"{stem}{ext}"
    in_path.write_bytes(upload.data)

    # Extract every decodable frame, in order, as scaled JPEGs.
    frame_pattern = tmp_root / f"{stem}_frame_%06d.jpg"
    extract_all = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(in_path),
            "-vsync",
            "0",
            "-vf",
            "scale='if(gt(iw,ih),1024,-2)':'if(gt(ih,iw),1024,-2)'",
            str(frame_pattern),
        ],
        check=False,
        capture_output=True,
    )
    if extract_all.returncode != 0:
        return []

    frame_files = sorted(tmp_root.glob(f"{stem}_frame_*.jpg"))
    out_urls: list[str] = []
    for frame_path in frame_files:
        jpg_b64 = base64.b64encode(frame_path.read_bytes()).decode("ascii")
        out_urls.append(f"data:image/jpeg;base64,{jpg_b64}")

    return out_urls


def _video_audio_to_transcript(upload: _DecodedUpload) -> str:
    tmp_root = _workspace_tmp_dir()
    safe_name = Path(upload.filename).name or "upload_video"
    stem = Path(safe_name).stem or "upload_video"
    in_path = tmp_root / f"{stem}.bin"
    wav_path = tmp_root / f"{stem}_audio.wav"
    in_path.write_bytes(upload.data)

    extract = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(in_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            str(wav_path),
        ],
        check=False,
        capture_output=True,
    )
    if extract.returncode != 0 or not wav_path.exists() or wav_path.stat().st_size == 0:
        logger.info("video audio extraction failed: name=%s", upload.filename)
        return ""

    try:
        model = _load_video_audio_stt_model()
        result = model.transcribe(str(wav_path))
        if hasattr(result, "text"):
            text = str(result.text or "").strip()
        else:
            text = str(result or "").strip()
        logger.info("video audio transcribed: name=%s chars=%d", upload.filename, len(text))
        return text
    except Exception as exc:
        logger.warning("video audio transcription failed: name=%s error=%s", upload.filename, exc)
        return ""


def _decode_data_url(value: str) -> tuple[str, bytes]:
    """Split a `data:<mime>;base64,<payload>` string into (mime, bytes)."""
    if value.startswith("data:") and "," in value:
        header, payload = value.split(",", 1)
        mime = header[5:].split(";")[0] or "image/jpeg"
    else:
        # Assume a bare base64 JPEG.
        mime, payload = "image/jpeg", value
    try:
        return mime, base64.b64decode(payload, validate=False)
    except Exception:
        return mime, b""


def _encode_data_url(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _shrink_image(data_url: str) -> tuple[str, int, int]:
    """Re-encode a camera frame so it fits a local model's context.

    Returns (data_url, width, height). Any failure — no Pillow, a format it
    cannot read, a frame already small enough — returns the original untouched,
    because a slightly-too-large image is far better than no image at all.
    """
    if not _ATRIUM_MAX_IMAGE_EDGE:
        return data_url, 0, 0
    try:
        from PIL import Image  # type: ignore
    except Exception:
        return data_url, 0, 0

    mime, raw = _decode_data_url(data_url)
    if not raw:
        return data_url, 0, 0

    try:
        import io as _io

        with Image.open(_io.BytesIO(raw)) as img:
            img.load()
            width, height = img.size
            longest = max(width, height)
            if longest <= _ATRIUM_MAX_IMAGE_EDGE and len(raw) < 220_000:
                return data_url, width, height
            if longest > _ATRIUM_MAX_IMAGE_EDGE:
                scale = _ATRIUM_MAX_IMAGE_EDGE / float(longest)
                img = img.resize(
                    (max(1, int(width * scale)), max(1, int(height * scale))),
                    Image.LANCZOS,
                )
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            out = _io.BytesIO()
            quality = max(1, min(95, _ATRIUM_IMAGE_QUALITY))
            img.save(out, format="JPEG", quality=quality, optimize=True)
            shrunk = out.getvalue()
    except Exception as exc:
        logger.info("camera frame resize skipped: %s", exc)
        return data_url, 0, 0

    if not shrunk or len(shrunk) >= len(raw):
        # Re-encoding made it bigger (already-optimised JPEG) — keep the original.
        return data_url, width, height
    return _encode_data_url("image/jpeg", shrunk), img.size[0], img.size[1]


def _image_part_to_supported(part: dict[str, Any], index: int) -> list[dict[str, Any]]:
    """Normalise one `input_image` part coming from the browser."""
    raw = part.get("image_url")
    if not isinstance(raw, str) or not raw.startswith("data:"):
        return []

    if _ATRIUM_STRIP_IMAGES:
        return [
            {
                "type": "input_text",
                "text": (
                    "[A camera frame was captured, but image input is disabled for this "
                    "model. Use the text observations that accompany it.]"
                ),
            }
        ]

    if index >= _ATRIUM_MAX_IMAGES_PER_ITEM:
        logger.info("camera frame dropped: over ATRIUM_MAX_IMAGES_PER_ITEM=%s", _ATRIUM_MAX_IMAGES_PER_ITEM)
        return []

    url, width, height = _shrink_image(raw)
    logger.info(
        "camera frame accepted: index=%s chars=%d%s",
        index,
        len(url),
        f" resized_to={width}x{height}" if width else "",
    )
    return [{"type": "input_image", "image_url": url}]


def _file_to_supported_parts(part: dict[str, Any]) -> list[dict[str, Any]]:
    upload = _decode_upload_payload(part)
    if upload is None:
        logger.warning("upload parse failed: missing or invalid file_data")
        return []

    mime = upload.mime_type.lower()
    name = upload.filename
    logger.info("upload received: name=%s mime=%s bytes=%d", name, upload.mime_type, len(upload.data))

    if mime.startswith("image/"):
        b64 = base64.b64encode(upload.data).decode("ascii")
        # Attached photos go through the same resize path as camera frames:
        # a phone-sized JPEG is several hundred kilobytes of base64, which a
        # local model cannot hold in its context window.
        return _image_part_to_supported({"image_url": f"data:{upload.mime_type};base64,{b64}"}, 0)

    if mime.startswith("video/"):
        transcript = _video_audio_to_transcript(upload)
        frames = _video_to_frame_data_urls(upload)
        logger.info(
            "video upload processed: name=%s frames=%d transcript_chars=%d",
            name,
            len(frames),
            len(transcript),
        )
        if not frames:
            return [
                {
                    "type": "input_text",
                    "text": f"Uploaded video file '{name}' could not be decoded into frames by the local backend.",
                }
            ]
        frame_count = len(frames)
        header = (
            f"User uploaded video file '{name}'. Every decodable frame was extracted and attached below in order."
            + f" Exactly {frame_count} frames were extracted from this video."
            + (f" The audio track was transcribed as: {transcript}" if transcript else "")
            + " If asked how many frames were analyzed, answer with this exact sampled-frame count."
        )

        parts: list[dict[str, Any]] = [{"type": "input_text", "text": header}]
        for idx, url in enumerate(frames, 1):
            parts.append({"type": "input_text", "text": f"Frame {idx} of {frame_count}."})
            parts.append({"type": "input_image", "image_url": url})
        return parts

    # For text-like files, provide the file contents directly to the model.
    text_exts = {".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".csv", ".html", ".css", ".sh"}
    ext = Path(name).suffix.lower()
    if mime.startswith("text/") or ext in text_exts:
        text = upload.data.decode("utf-8", errors="replace")
        snippet = text if len(text) <= 16000 else f"{text[:16000]}\n\n[truncated]"
        return [
            {
                "type": "input_text",
                "text": f"User uploaded file '{name}'. File contents:\n{snippet}",
            }
        ]

    return [
        {
            "type": "input_text",
            "text": f"User uploaded file '{name}' ({upload.mime_type}, {len(upload.data)} bytes).",
        }
    ]


def _normalize_conversation_item_create(raw: dict[str, Any]) -> dict[str, Any]:
    if raw.get("type") != "conversation.item.create":
        return raw
    item = raw.get("item")
    if not isinstance(item, dict):
        return raw
    if item.get("type") != "message" or item.get("role") != "user":
        return raw
    content = item.get("content")
    if not isinstance(content, list):
        return raw

    normalized: list[dict[str, Any]] = []
    changed = False
    image_index = 0
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "input_file":
            normalized.extend(_file_to_supported_parts(part))
            changed = True
        elif part.get("type") == "input_image":
            image_index += 1
            normalized.extend(_image_part_to_supported(part, image_index - 1))
            changed = True
        else:
            normalized.append(part)

    if not changed:
        return raw

    patched = dict(raw)
    patched_item = dict(item)
    patched_item["content"] = normalized
    patched["item"] = patched_item
    return patched


def _patched_parse_client_event(self: RealtimeService, raw: dict[str, Any]):
    if isinstance(raw, dict):
        raw = _normalize_conversation_item_create(raw)
    return _ORIGINAL_PARSE_CLIENT_EVENT(self, raw)


RealtimeService.parse_client_event = _patched_parse_client_event


def _patch_qwen3_gguf_paths() -> None:
    talker_path = os.environ.get("QWEN3_GGUF_TALKER_PATH", "").strip()
    codec_path = os.environ.get("QWEN3_GGUF_CODEC_PATH", "").strip()
    if not talker_path or not codec_path:
        return

    talker = Path(talker_path)
    codec = Path(codec_path)
    if not talker.is_file() or not codec.is_file():
        return

    from qwentts_cpp import models as qwentts_models

    def _resolve_local_gguf_paths(model_id: str, **_kwargs):
        return talker, codec

    qwentts_models.resolve_gguf_paths = _resolve_local_gguf_paths


_patch_qwen3_gguf_paths()


from speech_to_speech.s2s_pipeline import main


if __name__ == "__main__":
    sys.exit(main())