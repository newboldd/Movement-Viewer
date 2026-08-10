"""Video export: encode trim/crop/speed variants of the source video.

The client uploads the ORIGINAL video file once (cached across exports of
the same file, keyed by name+size+mtime), then each export runs ffmpeg
directly on it: input-seek to the trim start, crop in source pixels,
``setpts`` for speed, optional drawtext stamps.  ffmpeg decodes at full
CPU speed, so this is dramatically faster than the old flow (the client
seeking the <video> frame-by-frame, JPEG-encoding every frame, and
uploading thousands of stills before encoding could even start).
"""
from __future__ import annotations

import concurrent.futures
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..ffmpeg_util import get_ffmpeg_path

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/export-video", tags=["export"])

_active_exports: dict[str, dict[str, Any]] = {}
_STALE_SECONDS = 3600

# Uploaded source videos, cached for the server's lifetime so repeated
# exports of the same file skip the upload.  key -> file path, plus the
# container's true fps (probed at upload; used for progress scaling).
_SOURCE_DIR = tempfile.mkdtemp(prefix="viewer_sources_")
_source_cache: dict[str, str] = {}
_source_fps: dict[str, float] = {}
_MAX_SOURCES = 3

_FPS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*fps")


def _probe_fps(path: str) -> float | None:
    """Parse the stream fps from ``ffmpeg -i`` stderr (no ffprobe needed —
    imageio-ffmpeg only bundles the ffmpeg binary)."""
    try:
        ffmpeg = get_ffmpeg_path()
        result = subprocess.run([ffmpeg, "-i", path],
                                capture_output=True, text=True, timeout=30)
        m = _FPS_RE.search(result.stderr or "")
        if m:
            fps = float(m.group(1))
            if 1 <= fps <= 1000:
                return fps
    except Exception:
        pass
    return None


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


# ── Source upload / cache ────────────────────────────────────────────

@router.post("/source/check")
def check_source(body: dict = Body(...)) -> dict:
    """Return whether the source keyed by (name|size|mtime) is cached."""
    key = str(body.get("key", ""))
    path = _source_cache.get(key)
    if path and os.path.isfile(path):
        # Touch: move to the end of the (insertion-ordered) dict so LRU
        # eviction keeps the most recently used files.
        _source_cache[key] = _source_cache.pop(key)
        return {"cached": True}
    _source_cache.pop(key, None)
    return {"cached": False}


@router.post("/source/upload")
async def upload_source(request: Request, key: str, name: str = "video") -> dict:
    """Stream the raw source video body to the cache dir."""
    if not key:
        raise HTTPException(400, "Missing key")
    # Keep the extension so the demuxer hint survives; content sniffing
    # would work regardless, but this keeps temp files self-describing.
    ext = os.path.splitext(name)[1]
    if not re.fullmatch(r"\.\w{1,8}", ext or ""):
        ext = ".mp4"
    path = os.path.join(_SOURCE_DIR, uuid.uuid4().hex[:12] + ext)
    size = 0
    try:
        with open(path, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
                size += len(chunk)
    except Exception:
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    if size == 0:
        try:
            os.remove(path)
        except OSError:
            pass
        raise HTTPException(400, "Empty upload")
    _source_cache[key] = path
    fps = _probe_fps(path)
    if fps:
        _source_fps[key] = fps
    # LRU-evict beyond the cap.
    while len(_source_cache) > _MAX_SOURCES:
        old_key = next(iter(_source_cache))
        old_path = _source_cache.pop(old_key)
        _source_fps.pop(old_key, None)
        try:
            os.remove(old_path)
        except OSError:
            pass
    logger.info("Source cached (%d bytes, %s fps): %s", size, fps, key)
    return {"ok": True, "bytes": size}


# ── Export sessions ──────────────────────────────────────────────────

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
        "progress_files": [],
        "created": time.time(),
    }
    logger.info("Export %s: started (%d frames, %dx%d @ %sfps)",
                export_id, req.total_frames, req.width, req.height, req.fps)
    return {"export_id": export_id}


def _esc(text: str) -> str:
    """Escape drawtext metacharacters."""
    return (text.replace("\\", "\\\\")
                .replace(":", "\\:")
                .replace("'", r"\\'"))


def _build_vf(crop: tuple[int, int, int, int] | None,
              pad: tuple[int, int, int, int] | None,
              speed: float,
              badge_text: str | None,
              show_frame_num: bool,
              show_time: bool,
              start_frame_idx: int,
              client_fps: float) -> str:
    """Build the ``-vf`` chain: crop → pad → frame# → setpts (speed) → rest.

    - ``crop`` is (w, h, x, y) in source pixels (includes the stereo-half
      offset), or None for the full frame.
    - ``pad`` is (w, h, x, y): the full on-screen crop-box size and where
      the cropped pixels sit inside it.  The client's crop box may
      overhang the video frame (the video pans/zooms beneath the fixed
      box); the crop is clamped to real pixels and this pad restores the
      box's shape with black bars, so output matches what was drawn.
    - ``speed`` scales presentation timestamps (0.05 → 20x slow motion).
      Timing survives to the muxer because the encode runs ``-vsync vfr``.
    - ``badge_text`` (e.g. ``'0.5x'``) → big white box in the top-left.
    - ``show_frame_num`` → top-right label with the source frame index in
      the CLIENT's frame units (client_fps-guessed timeline, matching the
      viewer's frame counter).  Placed BEFORE setpts so ``t`` is still the
      source-relative time; the true container fps may differ from the
      client guess, so this maps time → client frame rather than counting
      output frames.
    - ``show_time`` → bottom-right label with the OUTPUT elapsed time
      (so a slowmo's clock ticks slowly), formatted HH:MM:SS.mmm.
    """
    parts: list[str] = []
    if crop:
        cw, ch, cx, cy = crop
        parts.append(f"crop={cw}:{ch}:{cx}:{cy}")
    if pad:
        pw, ph, px, py = pad
        parts.append(f"pad={pw}:{ph}:{px}:{py}:black")
    if show_frame_num:
        # %{eif:expr:d} formats expr as int; t = seconds since trim start.
        expr = f"%{{eif\\:trunc(t*{client_fps:g})+{int(start_frame_idx)}\\:d}}"
        parts.append("drawtext=text='f=" + expr + "'"
                     ":fontcolor=white"
                     ":fontsize=h/28"
                     ":box=1:boxcolor=black@0.55"
                     ":boxborderw=4"
                     ":x=w-text_w-10:y=10")
    if speed != 1.0:
        parts.append(f"setpts=PTS/{speed:g}")
    parts.append("pad=ceil(iw/2)*2:ceil(ih/2)*2")
    if badge_text:
        parts.append("drawtext=text='" + _esc(badge_text) + "'"
                     ":fontcolor=0x2d0f5a"
                     ":fontsize=h/12"
                     ":box=1:boxcolor=white@1"
                     ":boxborderw=10"
                     ":x=12:y=12")
    if show_time:
        parts.append("drawtext=text='%{pts\\:hms}'"
                     ":fontcolor=white"
                     ":fontsize=h/28"
                     ":box=1:boxcolor=black@0.55"
                     ":boxborderw=4"
                     ":x=w-text_w-10:y=h-text_h-10")
    return ",".join(parts)


def _encode_one(ffmpeg: str, src: str, out_path: str, prog_path: str,
                start_sec: float, dur_sec: float, vf: str, out_fps: float,
                threads: int) -> tuple[str, subprocess.CompletedProcess]:
    """Encode one MP4 variant directly from the source video."""
    cmd = [
        ffmpeg, "-y",
        # INPUT options: seek jumps to the nearest keyframe then decodes
        # and discards up to the target (fast AND frame-accurate), and -t
        # bounds the INPUT time read — trims by time, not frame count,
        # because the client's frame indices are based on a guessed fps
        # while time is the shared truth (a 60fps source keeps all its
        # frames within the selected range).
        "-ss", f"{start_sec:.6f}", "-t", f"{dur_sec:.6f}",
        "-i", src,
        "-vf", vf,
        # Force CFR at exactly real_fps×speed — this matches the setpts
        # spacing 1:1 (no dup/drop) and stops the muxer from re-stamping
        # frames back to the input rate, which would undo the speed change.
        "-r", f"{out_fps:g}",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        # Cap per-process threads so N parallel encodes don't
        # oversubscribe CPU.
        "-threads", str(threads),
        "-pix_fmt", "yuv420p",
        "-an",
        "-progress", prog_path,
        out_path,
    ]
    # subprocess.run drains stdout/stderr concurrently (communicate), so
    # this is safe from the Windows undrained-pipe deadlock.
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    return out_path, result


def _speed_tag(speed: float) -> str:
    """File-safe tag used in output filenames, e.g. 0.05 → '0p05x'."""
    s = f"{speed:g}".replace(".", "p")
    return f"{s}x"


@router.post("/{export_id}/encode-direct")
def encode_direct(export_id: str, body: dict = Body(...)):
    """Encode trim/crop/speed variants straight from the cached source.

    Body schema:
        {
          "key": "<source cache key>",
          "start_frame": 0, "end_frame": 100,        // inclusive
          "crop": {"x":0,"y":0,"w":960,"h":540,      // source px, optional
                   "pad_w":960,"pad_h":540,          //   full box size and
                   "pad_x":0,"pad_y":0},             //   crop offset in it
          "speeds": [{"speed": 1.0, "badge": false}, ...],
          "show_frame_num": false,
          "show_time": false
        }

    Returns {files, errors}; client then fetches each file via
    ``GET /{export_id}/file/{name}`` and finally ``DELETE``s the session.
    Poll ``GET /{export_id}/status`` while this request is in flight.
    """
    meta = _active_exports.get(export_id)
    if not meta:
        raise HTTPException(404, "Export session not found")

    src = _source_cache.get(str(body.get("key", "")))
    if not src or not os.path.isfile(src):
        raise HTTPException(410, "Source video not cached — re-upload")

    try:
        ffmpeg = get_ffmpeg_path()
    except FileNotFoundError as exc:
        raise HTTPException(500, str(exc))

    tmp_dir = meta["tmp_dir"]
    source_fps = float(meta["fps"]) or 30.0
    start_frame = int(body.get("start_frame", 0) or 0)
    end_frame = int(body.get("end_frame", 0) or 0)
    if end_frame < start_frame:
        raise HTTPException(400, "Empty frame range")
    n_frames = end_frame - start_frame + 1
    # Progress is reported in REAL encoded frames; scale the client-frame
    # count by the true container fps (probed at upload) over the client's
    # guessed fps so the fraction tracks accurately on e.g. 60fps sources.
    real_fps = float(_source_fps.get(str(body.get("key", ""))) or 0) or source_fps
    meta["total_frames"] = max(1, round(n_frames * real_fps / source_fps))

    crop = None
    pad = None
    c = body.get("crop")
    if isinstance(c, dict):
        try:
            cw, ch = int(c["w"]), int(c["h"])
            cx, cy = int(c["x"]), int(c["y"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(400, "Bad crop")
        if cw % 2:
            cw -= 1
        if ch % 2:
            ch -= 1
        if cw < 2 or ch < 2 or cx < 0 or cy < 0:
            raise HTTPException(400, "Bad crop")
        crop = (cw, ch, cx, cy)
        # Optional pad: restore the full crop-box shape when the box
        # overhangs the frame (black bars where there was no video).
        if "pad_w" in c or "pad_h" in c:
            try:
                pw, ph = int(c["pad_w"]), int(c["pad_h"])
                px, py = int(c.get("pad_x", 0)), int(c.get("pad_y", 0))
            except (KeyError, TypeError, ValueError):
                raise HTTPException(400, "Bad crop pad")
            if px < 0 or py < 0 or pw < px + cw or ph < py + ch:
                raise HTTPException(400, "Bad crop pad")
            if (pw, ph, px, py) != (cw, ch, 0, 0):
                pad = (pw, ph, px, py)

    show_frame_num = bool(body.get("show_frame_num", False))
    show_time = bool(body.get("show_time", False))

    # Accept either bare floats (legacy) or {speed, badge} dicts.
    raw_speeds = body.get("speeds") or [1.0]
    seen: set[float] = set()
    clean: list[tuple[float, bool]] = []
    for s in raw_speeds:
        if isinstance(s, dict):
            try:
                sv = float(s.get("speed"))
            except (TypeError, ValueError):
                continue
            bd = bool(s.get("badge", False))
        else:
            try:
                sv = float(s)
            except (TypeError, ValueError):
                continue
            bd = False
        if not math.isfinite(sv) or sv <= 0 or sv in seen:
            continue
        seen.add(sv)
        clean.append((sv, bd))
    if not clean:
        clean = [(1.0, False)]

    n_cores = max(1, (os.cpu_count() or 4))
    per_threads = max(1, n_cores // max(1, len(clean)))
    start_sec = start_frame / source_fps
    dur_sec = n_frames / source_fps

    jobs = []
    prog_files = []
    for sp, badge in clean:
        out_path = os.path.join(tmp_dir, f"export_{_speed_tag(sp)}.mp4")
        prog_path = os.path.join(tmp_dir, f"prog_{_speed_tag(sp)}.txt")
        badge_text = f"{sp:g}x" if badge else None
        vf = _build_vf(crop, pad, sp, badge_text, show_frame_num, show_time,
                       start_frame, source_fps)
        jobs.append((sp, out_path, prog_path, vf, real_fps * sp))
        prog_files.append(prog_path)
    meta["progress_files"] = prog_files

    files_out: list[dict] = []
    errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futs = {
            ex.submit(_encode_one, ffmpeg, src, op, pp, start_sec, dur_sec,
                      vf, ofps, per_threads): sp
            for sp, op, pp, vf, ofps in jobs
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
                export_id, len(files_out), n_frames)
    return {"files": files_out, "errors": errors}


_FRAME_RE = re.compile(rb"frame=(\d+)")


@router.get("/{export_id}/status")
def export_status(export_id: str) -> dict:
    """Encode progress 0..1 (mean across parallel speed encodes)."""
    meta = _active_exports.get(export_id)
    if not meta:
        raise HTTPException(404, "Export session not found")
    total = max(1, int(meta.get("total_frames") or 1))
    prog_files = meta.get("progress_files") or []
    if not prog_files:
        return {"progress": 0.0}
    fracs = []
    for pp in prog_files:
        frames = 0
        try:
            # Only the tail matters; progress blocks are ~200 bytes.
            with open(pp, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 4096))
                tail = f.read()
            m = _FRAME_RE.findall(tail)
            if m:
                frames = int(m[-1])
        except OSError:
            pass
        fracs.append(min(1.0, frames / total))
    return {"progress": sum(fracs) / len(fracs)}


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
