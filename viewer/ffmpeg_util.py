"""Locate an ffmpeg executable.

Checks the system PATH first, then falls back to the imageio-ffmpeg pip
package which bundles a static binary.  This lets the app work on a fresh
machine with no system-level installs — just ``pip install -r requirements.txt``.
"""
from __future__ import annotations

import shutil
from functools import lru_cache


@lru_cache(maxsize=1)
def get_ffmpeg_path() -> str:
    """Return the path to an ffmpeg executable."""
    path = shutil.which("ffmpeg")
    if path:
        return path
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        pass
    raise FileNotFoundError(
        "ffmpeg not found. Either install FFmpeg system-wide or "
        "run: pip install imageio-ffmpeg"
    )
