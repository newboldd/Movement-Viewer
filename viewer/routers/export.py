"""Video export: accept JPEG frames from client, encode to MP4 with ffmpeg.

Adapted from the movement-tracker export router, stripped down to the
endpoints actually used by the standalone viewer's in-page export flow.
"""
from __future__ import annotations

import concurrent.futures
import logging
import math
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..ffmpeg_util import get_ffmpeg_path

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/export-video", tags=["export"])

_active_exports: dict[str, dict[str, Any]] = {}
_STALE_SECONDS = 3600


class ExportStartRequest(BaseModel):
    fps: float
    width: int
    height: int
    total_frames: int


def _cleanup_stale() -> None:
    now = time.time()
    stale = [eid for eid, meta in _active_exports.items()
             if now - meta["created"] > _STALE_SECONDS]
    for eid in stale:
        meta = _active_exports.pop(eid, None)
        if meta and os.path.isdir(meta["tmp_dir"]):
            shutil.rmtree(meta["tmp_dir"], ignore_errors=True)
            logger.info("Cleaned stale export %s", eid)


@router.post("/start")
def start_export(req: ExportStartRequest) -> dict:
    """Create a new export session.  Returns {export_id}."""
    _cleanup_stale()
    export_id = uuid.uuid4().hex[:12]
    tmp_dir = tempfile.mkdtemp(prefix=f"viewer_export_{export_id}_")
    _active_exports[export_id] = {
        "tmp_dir": tmp_dir,
        "fps": req.fps,
        "width": req.width,
        "height": req.height,
        "total_frames": req.total_frames,
        "frames_received": 0,
        "created": time.time(),
    }
    logger.info("Export %s: started (%d frames, %dx%d @ %sfps)",
                export_id, req.total_frames, req.width, req.height, req.fps)
    return {"export_id": export_id}


@router.post("/{export_id}/frames")
async def upload_frames(export_id: str, request: Request) -> dict:
    """Upload a batch of JPEG frames via multipart form data."""
    meta = _active_exports.get(export_id)
    if not meta:
        raise HTTPException(404, "Export session not found")

    form = await request.form()
    start_index = int(form.get("start_index", 0))

    count = 0
    for key, value in form.items():
        if key == "start_index":
            continue
        if not hasattr(value, "read"):
            continue
        try:
            local_idx = int(key.split("_", 1)[1])
        except (IndexError, ValueError):
            local_idx = count
        global_idx = start_index + local_idx
        filepath = os.path.join(meta["tmp_dir"], f"frame_{global_idx:06d}.jpg")
        data = await value.read()
        with open(filepath, "wb") as f:
            f.write(data)
        count += 1

    meta["frames_received"] += count
    return {"received": count, "total_received": meta["frames_received"]}


class EncodeSpeed(BaseModel):
    speed: float
    badge: bool = False


class EncodeRequest(BaseModel):
    # Either a list of floats (legacy) or a list of {speed, badge}
    # objects.  Default [1.0] preserves the original behaviour.
    speeds: list[EncodeSpeed | float] | None = None


def _vf_for(badge_text: str | None) -> str:
    """Build the ``-vf`` filter chain.  Always pads odd dimensions; if
    ``badge_text`` is set, additionally burns a 'Nx' label into the
    top-left corner of the frame."""
    vf = "pad=ceil(iw/2)*2:ceil(ih/2)*2"
    if badge_text:
        # Escape ffmpeg drawtext metacharacters.
        safe = (badge_text.replace("\\", "\\\\")
                            .replace(":", "\\:")
                            .replace("'", r"\\'"))
        vf += (",drawtext=text='" + safe + "'"
               ":fontcolor=0x2d0f5a"
               ":fontsize=h/12"
               ":box=1:boxcolor=white@1"
               ":boxborderw=10"
               ":x=12:y=12")
    return vf


def _encode_one(ffmpeg: str, tmp_dir: str, out_fps: float, out_path: str,
                 threads: int, badge_text: str | None) -> tuple[str, subprocess.CompletedProcess]:
    """Encode one MP4 at the given output framerate.  Returns (path, result)."""
    cmd = [
        ffmpeg, "-y",
        "-framerate", str(out_fps),
        "-i", os.path.join(tmp_dir, "frame_%06d.jpg"),
        "-vf", _vf_for(badge_text),
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        # Cap per-process threads so N parallel encodes don't oversubscribe
        # CPU.  ``threads=0`` lets libx264 pick automatically.
        "-threads", str(threads),
        "-pix_fmt", "yuv420p",
        out_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    return out_path, result


def _speed_tag(speed: float) -> str:
    """File-safe tag used in output filenames, e.g. 0.05 → '0p05x'."""
    s = f"{speed:g}".replace(".", "p")
    return f"{s}x"


@router.post("/{export_id}/encode")
def encode_export(export_id: str, body: EncodeRequest | None = None):
    """Encode uploaded frames to one or more MP4s at the requested speeds.

    Returns JSON describing the produced files; client then fetches each
    file via ``GET /{export_id}/file/{name}`` and finally ``DELETE``s
    the session to clean up.
    """
    meta = _active_exports.get(export_id)
    if not meta:
        raise HTTPException(404, "Export session not found")

    tmp_dir = meta["tmp_dir"]
    source_fps = meta["fps"]
    frame_files = sorted(Path(tmp_dir).glob("frame_*.jpg"))
    if not frame_files:
        raise HTTPException(400, "No frames uploaded")

    try:
        ffmpeg = get_ffmpeg_path()
    except FileNotFoundError as exc:
        raise HTTPException(500, str(exc))

    raw_speeds = (body.speeds if body and body.speeds else [1.0])
    # Accept either bare floats (legacy) or {speed, badge} objects.
    seen = set()
    clean: list[tuple[float, bool]] = []
    for s in raw_speeds:
        if isinstance(s, EncodeSpeed):
            sv, bd = s.speed, bool(s.badge)
        else:
            try:
                sv = float(s)
            except (TypeError, ValueError):
                continue
            bd = False
        if not math.isfinite(sv) or sv <= 0:
            continue
        if sv in seen:
            continue
        seen.add(sv)
        clean.append((sv, bd))
    if not clean:
        clean = [(1.0, False)]

    # Pick a per-process thread count that gives each encode roughly an
    # equal share of cores, without oversubscribing.  Minimum of 1.
    n_cores = max(1, (os.cpu_count() or 4))
    per_threads = max(1, n_cores // max(1, len(clean)))

    jobs = []
    for sp, badge in clean:
        out_fps = float(source_fps) * sp
        out_path = os.path.join(tmp_dir, f"export_{_speed_tag(sp)}.mp4")
        badge_text = f"{sp:g}x" if badge else None
        jobs.append((sp, out_fps, out_path, badge_text))

    files_out: list[dict] = []
    errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futs = {
            ex.submit(_encode_one, ffmpeg, tmp_dir, of, op, per_threads, bt): sp
            for sp, of, op, bt in jobs
        }
        for fut in concurrent.futures.as_completed(futs):
            sp = futs[fut]
            try:
                path, result = fut.result()
            except Exception as e:
                errors.append(f"{sp}x: {e}")
                continue
            if result.returncode != 0:
                tail = result.stderr[-500:] if result.stderr else ""
                errors.append(f"{sp}x: ffmpeg rc={result.returncode}: {tail}")
                continue
            if not os.path.exists(path):
                errors.append(f"{sp}x: no output file produced")
                continue
            files_out.append({
                "speed": sp,
                "name": os.path.basename(path),
                "size": os.path.getsize(path),
            })

    if errors and not files_out:
        # Every encode failed → session is unusable; tear down.
        _active_exports.pop(export_id, None)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(500, "ffmpeg encode failed: " + "; ".join(errors))

    files_out.sort(key=lambda f: f["speed"])
    logger.info("Export %s: encoded %d speed(s) (%d frames each)",
                export_id, len(files_out), len(frame_files))
    return {"files": files_out, "errors": errors}


@router.get("/{export_id}/file/{name}")
def download_file(export_id: str, name: str):
    """Stream one of the produced MP4s.  Cleanup happens on DELETE."""
    meta = _active_exports.get(export_id)
    if not meta:
        raise HTTPException(404, "Export session not found")
    # Reject path traversal — the filename must be one we wrote.
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "Bad filename")
    path = os.path.join(meta["tmp_dir"], name)
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type="video/mp4", filename=name)


@router.delete("/{export_id}")
def cancel_export(export_id: str) -> dict:
    """Cancel and clean up an export session."""
    meta = _active_exports.pop(export_id, None)
    if meta and os.path.isdir(meta["tmp_dir"]):
        shutil.rmtree(meta["tmp_dir"], ignore_errors=True)
    return {"status": "cancelled"}
