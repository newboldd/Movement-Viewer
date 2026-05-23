"""Movement Viewer — standalone stereo/mono video browser with trim + crop export.

Tiny FastAPI app: one HTML page, one JS bundle, plus a small /api/export-video/*
group for server-side ffmpeg encoding.  No database, no subjects, no jobs.
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .routers import export

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="Movement Viewer")

_STATIC = Path(__file__).resolve().parent / "static"

app.include_router(export.router)
app.mount("/static", StaticFiles(directory=str(_STATIC)), name="static")


@app.get("/")
def index():
    return FileResponse(str(_STATIC / "index.html"))


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}
