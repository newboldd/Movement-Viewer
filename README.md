# Movement Viewer

A standalone stereo / mono video browser with trim + crop + slow-mo export.
No subjects, no database, no computer vision — just open a video, scrub it,
optionally crop & trim, and export to MP4.

## Quick start

**Mac / Linux:**

```bash
./setup.sh
```

**Windows:**

Double-click `run.bat`.

Both scripts install Python 3.11 (locally, if missing), create a venv, install
dependencies, and open the viewer at <http://localhost:8090>.

The Windows installer has fallback strategies for locked-down hospital /
hospital-network machines (portable Python in `%LOCALAPPDATA%`, pip.pyz to
avoid `.exe`-blocking Group Policies, optional `wheels/` directory for fully
offline installs).

## Offline install on a locked-down Windows machine

On an unrestricted machine with internet:

```cmd
pip download -r requirements.txt -d wheels\
```

Then copy the `wheels/` folder into this project directory and run `run.bat`.
The installer will detect it and install from local wheels.

## Controls

- **Browse…** — opens any local video file.
- **Stereo** — auto-checked when the loaded file is wider than 2:1 (e.g.
  3840×1080 side-by-side). Uncheck to view the full frame.
- **Mouse-wheel** on the canvas zooms around the cursor.
- **Drag** the canvas to pan.
- **Z** resets zoom, **E** switches camera (stereo only), arrow keys step
  frames, space plays/pauses.
- **Speed** ranges from 0.01× up to 120× (slower than 0.0625× is implemented
  via manual frame-stepping so the browser's `<video>` rate floor doesn't
  apply).
- **Export Video** enters export mode: the timeline becomes a pair of orange
  trim handles; an orange crop box overlays the canvas (8 resize handles,
  drag the inside to move, double-click inside to reset to the visible video
  rect with the source aspect). Click **Export** to encode the trimmed + cropped
  region at the current speed; **Cancel** aborts (mid-export too).
