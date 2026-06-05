<p align="center">
  <img src="play_icon_2.png" alt="Movement Viewer" width="220">
</p>

<h1 align="center">Movement Viewer</h1>

<p align="center">
  <em>A standalone stereo / mono video browser</em><br>
  for clinicians who want to scrub, slow down, trim, and crop a video — no database, no setup beyond a double-click.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-blue.svg"></a>
  <a href="#"><img alt="Python 3.11" src="https://img.shields.io/badge/python-3.11-3776ab.svg?logo=python&logoColor=white"></a>
  <a href="https://fastapi.tiangolo.com/"><img alt="FastAPI" src="https://img.shields.io/badge/web-FastAPI-009688?logo=fastapi&logoColor=white"></a>
  <a href="https://ffmpeg.org/"><img alt="ffmpeg" src="https://img.shields.io/badge/encode-ffmpeg-007808.svg"></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-controls">Controls</a> ·
  <a href="#-offline-install-on-a-locked-down-windows-machine">Offline install</a> ·
  <a href="#-license">License</a>
</p>

---

## 🚀 Quick start

**macOS / Linux:**

```bash
git clone https://github.com/newboldd/Movement-Viewer
cd Movement-Viewer
./setup.sh
```

**Windows:**

Double-click `run.bat`.

Both scripts install Python 3.11 (locally, if missing), create a venv, install dependencies, and open the viewer at **http://localhost:8090**.

<table>
  <tr>
    <td><strong>macOS</strong> — double-click <code>Movement Viewer.app</code> in the repo (or drag it to your Dock) once the first <code>setup.sh</code> run has completed.</td>
  </tr>
  <tr>
    <td><strong>Windows</strong> — <code>run.bat</code> has fallback strategies for locked-down hospital networks: portable Python in <code>%LOCALAPPDATA%</code>, <code>pip.pyz</code> to dodge <code>.exe</code>-blocking Group Policies, optional <code>wheels/</code> directory for fully offline installs.</td>
  </tr>
</table>

---

## 🎞️ Features

<table>
  <tr>
    <td valign="top" width="50%">
      <h3>🔍 Scrub + zoom</h3>
      Mouse-wheel zooms around the cursor, drag pans. Arrow keys step frames; space plays / pauses. <strong>Z</strong> resets zoom, <strong>E</strong> swaps cameras on stereo footage.
    </td>
    <td valign="top" width="50%">
      <h3>🐢 Variable speed</h3>
      From 0.01× up to 120×. Below 0.0625× the player falls back to manual frame-stepping so the browser's <code>&lt;video&gt;</code> rate floor doesn't apply.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>👀 Stereo or mono</h3>
      Auto-detects side-by-side stereo (anything wider than 2:1, e.g. 3840×1080) and lets you view one half at a time. Uncheck Stereo to view the whole frame.
    </td>
    <td valign="top">
      <h3>✂️ Trim + crop + export</h3>
      Enter <strong>Export Video</strong> mode and the timeline becomes a pair of orange trim handles; an orange crop box overlays the canvas with 8 resize handles. Encode the trimmed + cropped region to MP4 at the current playback speed.
    </td>
  </tr>
</table>

---

## 🎛️ Controls

| Action | Input |
|---|---|
| Open a video | **Browse…** button |
| Toggle stereo / mono | **Stereo** checkbox (auto-set when the file is wider than 2:1) |
| Zoom around cursor | **Mouse-wheel** |
| Pan | **Drag** |
| Step frames | **← / →** |
| Play / pause | **Space** |
| Reset zoom | **Z** |
| Swap cameras (stereo) | **E** |
| Change playback rate | **Speed** slider (0.01× – 120×) |
| Trim + crop + export | **Export Video** → set handles → **Export** / **Cancel** |

Inside **Export Video** mode, the orange crop overlay supports drag-the-inside to move and double-click-inside to reset to the visible video rect with the source aspect.

---

## 📦 Offline install on a locked-down Windows machine

On an unrestricted machine with internet:

```cmd
pip download -r requirements.txt -d wheels\
```

Then copy the `wheels/` folder into this project directory and run `run.bat`. The installer detects it and installs from local wheels — no network calls needed.

---

## 🧩 Dependencies

| Library |
|---|
| [FastAPI](https://fastapi.tiangolo.com/) · [uvicorn](https://www.uvicorn.org/) |
| [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg) (bundles the ffmpeg binary) |
| [Pydantic](https://docs.pydantic.dev/) |

Full list in `requirements.txt`; installed automatically by `setup.sh` / `run.bat`.

---

## 📚 Citation

If you use this software in published research, please cite it:

```bibtex
@software{newbold_movement_viewer,
  author  = {Newbold, Dillan},
  title   = {Movement Viewer},
  url     = {https://github.com/newboldd/Movement-Viewer},
  license = {BUSL-1.1}
}
```

A [`CITATION.cff`](CITATION.cff) file is included so GitHub shows a **Cite this repository** button in the sidebar.

---

## 📜 License

[**Business Source License 1.1**](LICENSE) — see [`LICENSE`](LICENSE) for the full terms.

- **Additional Use Grant:** free for non-commercial academic research and educational purposes without restriction.
- **Change Date:** four years from the date each version is first published.
- **Change License:** MIT.

For commercial use before the Change Date, please get in touch.

<p align="center">
  <sub>A companion to <a href="https://github.com/newboldd/movement-tracker">Movement Tracker</a>. Made open for clinicians and scientists who just want to look at a video.</sub>
</p>
