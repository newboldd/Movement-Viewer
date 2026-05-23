/**
 * Movement Viewer — standalone video browser.
 *
 * Adapted (and stripped) from movement-tracker's videos.js.  No subjects,
 * no trials, no MediaPipe hints: just open a video file, zoom/pan/scrub
 * it, optionally crop + trim + slow-mo to MP4 via the local Python server.
 */
(function () {
    'use strict';

    const SPEED_PRESETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 30, 60, 120];
    const SPEED_DEFAULT_IDX = SPEED_PRESETS.indexOf(1);

    // ── State ────────────────────────────────────────────────
    let videoEl = null;
    let vidW = 0, vidH = 0, midline = 0;
    let isStereo = false;
    let nFrames = 0;
    let fps = 30;
    let currentFrame = 0;
    let playing = false;
    let playTimer = null;
    let playbackRate = 1;

    const cameraNames = ['OS', 'OD'];
    let currentSide = 'OS';
    let currentCameraIdx = 0;

    let canvas, ctx;

    // Zoom/pan
    let scale = 1, offsetX = 0, offsetY = 0;
    let dragging = false;
    let dragStartX = 0, dragStartY = 0;
    let panStartOX = 0, panStartOY = 0;

    // Export-mode state + crop box (canvas-buffer coords)
    let exportMode = false;
    let exportRunning = false;
    let exportAbort = null;
    let exportAbortRequested = false;
    let cropX = 0, cropY = 0, cropW = 0, cropH = 0;
    let cropDragMode = null;
    let cropDragStart = null;
    const CROP_COLOR = '#5cff5c';   // bright green; matches --lime in main.css
    const CROP_HANDLE = 10;
    const CROP_HANDLE_DRAW = 8;

    const $ = id => document.getElementById(id);
    function dbg() {}   // no-op placeholder

    // IDs of controls that should only be active once a video is loaded.
    const _GATED_IDS = [
        'timelineSlider', 'prevFrameBtn', 'playBtn', 'nextFrameBtn',
        'speedSlider', 'sideToggle', 'resetZoomBtn',
        'exportBtn', 'stereoCheckbox',
    ];
    function _setLoaded(loaded) {
        for (const id of _GATED_IDS) {
            const el = document.getElementById(id);
            if (el) el.disabled = !loaded;
        }
    }

    // ── Init ────────────────────────────────────────────────
    function init() {
        canvas = $('canvas');
        ctx = canvas.getContext('2d');
        videoEl = document.createElement('video');
        videoEl.muted = true;
        setupControls();
        setupCanvasEvents();
        _wireTrimHandles();
        sizeCanvas();
        render();
    }

    // ── File loading ─────────────────────────────────────────
    function loadFile(file) {
        if (!file) return;
        // Reset state
        currentFrame = 0;
        scale = 1; offsetX = 0; offsetY = 0;
        if (playing) togglePlay();

        const url = URL.createObjectURL(file);
        // Probe duration first, then fps if possible.
        videoEl.src = url;
        videoEl.addEventListener('loadedmetadata', () => {
            vidW = videoEl.videoWidth;
            vidH = videoEl.videoHeight;
            // Auto-detect stereo: side-by-side videos are markedly wider
            // than 1:1 (e.g. 3840×1080).  Threshold at 2:1.
            const stereoGuess = vidW >= 2 * vidH;
            $('stereoCheckbox').checked = stereoGuess;
            isStereo = stereoGuess;
            midline = isStereo ? Math.round(vidW / 2) : vidW;
            currentSide = cameraNames[0];
            currentCameraIdx = 0;
            updateCameraButton();
            // No reliable JS API for "frame count" / "frame rate" on <video>.
            // Use a sensible default (30) and let the user infer.  If the
            // browser reports a more precise duration we still align frames
            // to that, just with a fixed 30 fps cadence — good enough for
            // visual scrubbing and identical to what the legacy viewer did
            // for files browsed outside the dataset.
            fps = 30;
            nFrames = Math.max(1, Math.round(videoEl.duration * fps));
            $('totalFramesDisplay').textContent = nFrames;
            $('timelineSlider').max = nFrames - 1;
            $('timelineSlider').value = 0;
            $('frameDisplay').textContent = 0;
            $('dropHint').classList.add('hidden');
            _setLoaded(true);
            sizeCanvas();
            // Seek to mid-first-frame (t=0 is often un-decodable).
            videoEl.currentTime = Math.min(0.5 / fps, videoEl.duration);
            videoEl.addEventListener('seeked', render, { once: true });
        }, { once: true });
    }

    // ── Controls ────────────────────────────────────────────
    function setupControls() {
        $('prevFrameBtn').addEventListener('click', () => goToFrame(currentFrame - 1));
        $('nextFrameBtn').addEventListener('click', () => goToFrame(currentFrame + 1));
        $('playBtn').addEventListener('click', togglePlay);
        $('sideToggle').addEventListener('click', switchCamera);
        $('resetZoomBtn').addEventListener('click', resetZoom);

        $('browseBtn').addEventListener('click', () => $('browseInput').click());
        $('browseInput').addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) loadFile(file);
            e.target.value = '';
        });

        $('stereoCheckbox').addEventListener('change', e => {
            isStereo = !!e.target.checked;
            midline = isStereo ? Math.round(vidW / 2) : vidW;
            currentSide = cameraNames[0];
            currentCameraIdx = 0;
            updateCameraButton();
            scale = 1; offsetX = 0; offsetY = 0;
            render();
            e.target.blur();   // return focus so space-bar reaches play/pause
        });

        // Speed slider
        const speedSlider = $('speedSlider');
        speedSlider.min = 0;
        speedSlider.max = SPEED_PRESETS.length - 1;
        speedSlider.value = SPEED_DEFAULT_IDX;
        playbackRate = SPEED_PRESETS[SPEED_DEFAULT_IDX];
        $('speedDisplay').textContent = playbackRate + 'x';
        speedSlider.addEventListener('input', () => {
            playbackRate = SPEED_PRESETS[parseInt(speedSlider.value)];
            $('speedDisplay').textContent = playbackRate + 'x';
            if (playing && playbackRate >= 0.0625) {
                videoEl.playbackRate = Math.max(0.0625, Math.min(playbackRate, 16));
            }
        });
        // Blur on release so subsequent space-bar presses hit Play/Pause
        // (keyboard listener skips events whose target is an INPUT).
        speedSlider.addEventListener('change', () => speedSlider.blur());

        // Timeline scrub
        const timeline = $('timelineSlider');
        timeline.addEventListener('input', () => {
            if (!nFrames) return;
            goToFrame(parseInt(timeline.value));
        });
        timeline.addEventListener('change', () => timeline.blur());

        // Keyboard shortcuts
        document.addEventListener('keydown', e => {
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
            switch (e.key) {
                case 'a': case 'ArrowLeft':  goToFrame(currentFrame - 1); e.preventDefault(); break;
                case 's': case 'ArrowRight': goToFrame(currentFrame + 1); e.preventDefault(); break;
                case ' ': togglePlay(); e.preventDefault(); break;
                case 'e': case 'E': switchCamera(); break;
                case 'z': case 'Z': resetZoom(); break;
            }
        });
    }

    // ── Camera toggle (OS | OD) ─────────────────────────────
    function updateCameraButton() {
        const btn = $('sideToggle');
        if (!isStereo) { btn.style.display = 'none'; return; }
        btn.style.display = '';
        const opts = [cameraNames[0], cameraNames[1]];
        const act = 'color:var(--btn-text);font-weight:700;';
        const ina = 'color:var(--violet-bright);font-weight:500;';
        btn.innerHTML = opts.map((name, i) => {
            const span = `<span style="${name === currentSide ? act : ina}">${name}</span>`;
            const sep = (i < opts.length - 1)
                ? `<span style="opacity:0.35;margin:0 3px;">|</span>` : '';
            return span + sep;
        }).join('');
    }

    function switchCamera() {
        if (!isStereo) return;
        currentCameraIdx = (currentCameraIdx + 1) % 2;
        currentSide = cameraNames[currentCameraIdx];
        updateCameraButton();
        render();
    }

    // ── Playback ─────────────────────────────────────────────
    function goToFrame(n) {
        if (!nFrames) return;
        currentFrame = Math.max(0, Math.min(n, nFrames - 1));
        $('frameDisplay').textContent = currentFrame;
        $('timelineSlider').value = currentFrame;
        if (videoEl.readyState >= 2 && fps) {
            videoEl.currentTime = (currentFrame + 0.5) / fps;
            videoEl.addEventListener('seeked', render, { once: true });
        }
    }

    function togglePlay() {
        if (!nFrames) return;
        if (playing) {
            playing = false;
            videoEl.pause();
            if (playTimer) {
                if (typeof playTimer === 'number') clearTimeout(playTimer);
                else cancelAnimationFrame(playTimer);
                playTimer = null;
            }
            $('playBtn').innerHTML = '&#9654;';
        } else {
            playing = true;
            $('playBtn').innerHTML = '&#9646;&#9646;';
            if (playbackRate >= 0.0625) {
                videoEl.playbackRate = Math.min(playbackRate, 16);
                videoEl.play().catch(() => {});
                playLoop();
            } else {
                videoEl.pause();
                playStepManual();
            }
        }
    }

    function playLoop() {
        if (!playing) return;
        if (videoEl.readyState >= 2 && fps) {
            const f = Math.floor(videoEl.currentTime * fps);
            if (f !== currentFrame && f >= 0 && f < nFrames) {
                currentFrame = f;
                $('frameDisplay').textContent = currentFrame;
                $('timelineSlider').value = currentFrame;
                render();
            }
            if (f >= nFrames - 1) { togglePlay(); return; }
        }
        playTimer = requestAnimationFrame(playLoop);
    }

    function playStepManual() {
        if (!playing) return;
        if (currentFrame >= nFrames - 1) { togglePlay(); return; }
        goToFrame(currentFrame + 1);
        const ms = 1000 / Math.max(fps * playbackRate, 0.1);
        playTimer = setTimeout(playStepManual, ms);
    }

    // ── Zoom / pan ───────────────────────────────────────────
    function resetZoom() {
        scale = 1; offsetX = 0; offsetY = 0;
        render();
    }

    function ensureCanvasSized() {
        const vp = canvas.parentElement;
        if (!vp) return;
        if (canvas.width !== vp.clientWidth || canvas.height !== vp.clientHeight) {
            sizeCanvas();
        }
    }

    function getBaseMetrics() {
        const w = canvas.width, h = canvas.height;
        const sw = isStereo ? midline : vidW;
        if (!(sw > 0) || !(vidH > 0) || !(w > 0) || !(h > 0)) {
            return { bps: 0, baseOX: 0, baseOY: 0, sw: 0 };
        }
        const bps = Math.min(w / sw, h / vidH);
        const baseOX = (w - sw * bps) / 2;
        const baseOY = (h - vidH * bps) / 2;
        return { bps, baseOX, baseOY, sw };
    }

    function setupCanvasEvents() {
        const _bufXY = e => {
            const rect = canvas.getBoundingClientRect();
            const csx = canvas.width / rect.width;
            const csy = canvas.height / rect.height;
            return { mx: (e.clientX - rect.left) * csx,
                     my: (e.clientY - rect.top)  * csy };
        };

        // Wheel-zoom around the cursor.
        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            ensureCanvasSized();
            if (!isFinite(offsetX) || !isFinite(offsetY) || !isFinite(scale) || scale <= 0) {
                scale = 1; offsetX = 0; offsetY = 0;
            }
            const { mx, my } = _bufXY(e);
            const { baseOX, baseOY } = getBaseMetrics();
            const lx = mx - baseOX;
            const ly = my - baseOY;
            const factor = e.deltaY < 0 ? 1.025 : 1 / 1.025;
            const ns = Math.max(0.1, Math.min(scale * factor, 50));
            offsetX = lx - (lx - offsetX) * (ns / scale);
            offsetY = ly - (ly - offsetY) * (ns / scale);
            scale = ns;
            render();
        }, { passive: false });

        canvas.addEventListener('mousedown', e => {
            if (e.button !== 0 && e.button !== 1) return;
            ensureCanvasSized();
            if (!isFinite(offsetX) || !isFinite(offsetY) || !isFinite(scale) || scale <= 0) {
                scale = 1; offsetX = 0; offsetY = 0;
            }
            // Crop box wins over pan when in export mode.
            if (exportMode) {
                const { mx, my } = _bufXY(e);
                const hit = _cropHitTest(mx, my);
                if (hit) {
                    cropDragMode = hit;
                    cropDragStart = { mx, my, x: cropX, y: cropY, w: cropW, h: cropH };
                    e.preventDefault();
                    return;
                }
            }
            dragging = true;
            dragStartX = e.clientX; dragStartY = e.clientY;
            panStartOX = offsetX;   panStartOY = offsetY;
            e.preventDefault();
        });

        canvas.addEventListener('mousemove', e => {
            if (!exportMode || cropDragMode || dragging) return;
            const { mx, my } = _bufXY(e);
            canvas.style.cursor = _cursorForCrop(_cropHitTest(mx, my));
        });
        canvas.addEventListener('mouseleave', () => {
            if (!cropDragMode && !dragging) canvas.style.cursor = '';
        });

        canvas.addEventListener('dblclick', e => {
            if (!exportMode) return;
            const { mx, my } = _bufXY(e);
            if (mx >= cropX && mx <= cropX + cropW &&
                my >= cropY && my <= cropY + cropH) {
                _resetCropToView();
                render();
                e.preventDefault();
            }
        });

        window.addEventListener('mousemove', e => {
            if (cropDragMode) {
                const { mx, my } = _bufXY(e);
                const s = cropDragStart;
                const dx = mx - s.mx, dy = my - s.my;
                const minSize = 20;
                const r = _visibleVideoRect();
                if (cropDragMode === 'move') {
                    const maxX = (r.right - r.left) - s.w;
                    const maxY = (r.bot   - r.top)  - s.h;
                    cropX = r.left + Math.max(0, Math.min(maxX, (s.x - r.left) + dx));
                    cropY = r.top  + Math.max(0, Math.min(maxY, (s.y - r.top)  + dy));
                } else {
                    let nx = s.x, ny = s.y, nw = s.w, nh = s.h;
                    if (cropDragMode.includes('w')) {
                        nx = Math.max(r.left, Math.min(s.x + s.w - minSize, s.x + dx));
                        nw = s.x + s.w - nx;
                    }
                    if (cropDragMode.includes('e')) {
                        nw = Math.max(minSize, Math.min(r.right - s.x, s.w + dx));
                    }
                    if (cropDragMode.includes('n')) {
                        ny = Math.max(r.top, Math.min(s.y + s.h - minSize, s.y + dy));
                        nh = s.y + s.h - ny;
                    }
                    if (cropDragMode.includes('s')) {
                        nh = Math.max(minSize, Math.min(r.bot - s.y, s.h + dy));
                    }
                    cropX = nx; cropY = ny; cropW = nw; cropH = nh;
                }
                render();
                return;
            }
            if (!dragging) return;
            offsetX = panStartOX + (e.clientX - dragStartX);
            offsetY = panStartOY + (e.clientY - dragStartY);
            render();
        });
        window.addEventListener('mouseup', () => {
            if (cropDragMode) { cropDragMode = null; cropDragStart = null; return; }
            if (dragging) { dragging = false; }
        });

        const ro = new ResizeObserver(() => { sizeCanvas(); render(); });
        ro.observe(canvas.parentElement);
    }

    function sizeCanvas() {
        const vp = canvas.parentElement;
        if (!vp) return;
        canvas.width  = vp.clientWidth;
        canvas.height = vp.clientHeight;
    }

    // ── Crop overlay ─────────────────────────────────────────
    function _visibleVideoRect() {
        const { bps, baseOX, baseOY, sw } = getBaseMetrics();
        if (!(bps > 0) || !canvas) {
            return { left: 0, top: 0,
                     right: canvas ? canvas.width  : 0,
                     bot:   canvas ? canvas.height : 0,
                     bps, sw };
        }
        const imgX = baseOX + offsetX;
        const imgY = baseOY + offsetY;
        const imgW = sw * bps * scale;
        const imgH = vidH * bps * scale;
        return {
            left:  Math.max(0, imgX),
            top:   Math.max(0, imgY),
            right: Math.min(canvas.width,  imgX + imgW),
            bot:   Math.min(canvas.height, imgY + imgH),
            bps, sw,
        };
    }

    function _resetCropToView() {
        const r = _visibleVideoRect();
        let w = r.right - r.left;
        let h = r.bot - r.top;
        if (!(w > 0) || !(h > 0) || !(vidH > 0) || !(r.sw > 0)) {
            cropX = r.left; cropY = r.top;
            cropW = Math.max(20, w);
            cropH = Math.max(20, h);
            return;
        }
        const targetAspect = r.sw / vidH;
        if (w / h > targetAspect) { w = h * targetAspect; }
        else                     { h = w / targetAspect; }
        cropX = r.left;
        cropY = r.top;
        cropW = Math.max(20, w);
        cropH = Math.max(20, h);
    }

    function _cropHandles() {
        const x = cropX, y = cropY, w = cropW, h = cropH;
        return [
            { name: 'nw', x: x,         y: y         },
            { name: 'n',  x: x + w / 2, y: y         },
            { name: 'ne', x: x + w,     y: y         },
            { name: 'w',  x: x,         y: y + h / 2 },
            { name: 'e',  x: x + w,     y: y + h / 2 },
            { name: 'sw', x: x,         y: y + h     },
            { name: 's',  x: x + w / 2, y: y + h     },
            { name: 'se', x: x + w,     y: y + h     },
        ];
    }

    function _cropHitTest(mx, my) {
        if (!exportMode) return null;
        for (const h of _cropHandles()) {
            if (Math.abs(mx - h.x) <= CROP_HANDLE &&
                Math.abs(my - h.y) <= CROP_HANDLE) {
                return h.name;
            }
        }
        if (mx >= cropX && mx <= cropX + cropW &&
            my >= cropY && my <= cropY + cropH) {
            return 'move';
        }
        return null;
    }

    function _cursorForCrop(hit) {
        switch (hit) {
            case 'move': return 'move';
            case 'n': case 's':  return 'ns-resize';
            case 'e': case 'w':  return 'ew-resize';
            case 'nw': case 'se': return 'nwse-resize';
            case 'ne': case 'sw': return 'nesw-resize';
            default: return '';
        }
    }

    function _drawCropOverlay() {
        if (!exportMode || exportRunning) return;
        if (!(cropW > 0) || !(cropH > 0)) return;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, canvas.width, cropY);
        ctx.fillRect(0, cropY + cropH, canvas.width, canvas.height - (cropY + cropH));
        ctx.fillRect(0, cropY, cropX, cropH);
        ctx.fillRect(cropX + cropW, cropY, canvas.width - (cropX + cropW), cropH);
        ctx.strokeStyle = CROP_COLOR;
        ctx.lineWidth = 2;
        ctx.strokeRect(cropX + 1, cropY + 1, cropW - 2, cropH - 2);
        const s = CROP_HANDLE_DRAW;
        for (const h of _cropHandles()) {
            const hx = Math.max(s / 2, Math.min(canvas.width  - s / 2, h.x));
            const hy = Math.max(s / 2, Math.min(canvas.height - s / 2, h.y));
            ctx.fillStyle = CROP_COLOR;
            ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.strokeRect(hx - s / 2 + 0.5, hy - s / 2 + 0.5, s - 1, s - 1);
        }
        ctx.restore();
    }

    // ── Rendering ────────────────────────────────────────────
    function render() {
        if (!ctx) return;
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, w, h);
        if (!videoEl || videoEl.readyState < 2 || vidW === 0) return;

        const isFirst = currentSide === cameraNames[0];
        const sx = isStereo ? (isFirst ? 0 : midline) : 0;
        const { bps, baseOX, baseOY, sw } = getBaseMetrics();

        ctx.save();
        ctx.translate(baseOX + offsetX, baseOY + offsetY);
        ctx.scale(scale, scale);
        ctx.drawImage(videoEl, sx, 0, sw, vidH, 0, 0, sw * bps, vidH * bps);
        ctx.restore();
        _drawCropOverlay();
    }

    // ── Export mode ──────────────────────────────────────────
    function _updateTrimTrack() {
        const tStart = $('trimStart'), tEnd = $('trimEnd'), track = $('trimTrack');
        if (!tStart || !tEnd || !track) return;
        const max = parseInt(tStart.max) || 1;
        const a = Math.min(parseInt(tStart.value), parseInt(tEnd.value));
        const b = Math.max(parseInt(tStart.value), parseInt(tEnd.value));
        const aP = (a / max) * 100;
        const bP = (b / max) * 100;
        track.style.background =
            `linear-gradient(to right,
                ${CROP_COLOR} 0%, ${CROP_COLOR} ${aP}%,
                #2196f3 ${aP}%, #2196f3 ${bP}%,
                ${CROP_COLOR} ${bP}%, ${CROP_COLOR} 100%)`;
    }

    function enterExportMode() {
        if (!nFrames) { alert('Open a video first'); return; }
        if (playing) togglePlay();
        exportMode = true;
        document.body.classList.add('export-mode');
        const tStart = $('trimStart'), tEnd = $('trimEnd');
        tStart.min = tEnd.min = 0;
        tStart.max = tEnd.max = Math.max(0, nFrames - 1);
        tStart.value = 0;
        tEnd.value = Math.max(0, nFrames - 1);
        $('timelineSlider').style.display = 'none';
        $('trimUI').style.display = '';
        _updateTrimTrack();
        const btn = $('exportBtn');
        btn.textContent = 'Export';
        btn.classList.add('btn-primary');
        $('exportCancelBtn').style.display = '';
        $('exportStatus').textContent = '';
        _resetCropToView();
        render();
    }

    function exitExportMode() {
        if (exportRunning) { _cancelRunningExport(); return; }
        exportMode = false;
        document.body.classList.remove('export-mode');
        $('timelineSlider').style.display = '';
        $('trimUI').style.display = 'none';
        const btn = $('exportBtn');
        btn.textContent = 'Export Video';
        btn.classList.remove('btn-primary');
        btn.disabled = false;
        $('exportCancelBtn').style.display = 'none';
        $('exportStatus').textContent = '';
        cropDragMode = null;
        cropDragStart = null;
        canvas.style.cursor = '';
        render();
    }

    function toggleExportMode() {
        if (!exportMode) enterExportMode();
        else runExport();
    }

    function _cancelRunningExport() {
        if (!exportRunning) return;
        exportAbortRequested = true;
        if (exportAbort) { try { exportAbort.abort(); } catch (_) {} }
        const status = $('exportStatus');
        if (status) status.textContent = 'Cancelling…';
        const cancelBtn = $('exportCancelBtn');
        if (cancelBtn) cancelBtn.disabled = true;
    }

    function _wireTrimHandles() {
        const tStart = $('trimStart'), tEnd = $('trimEnd');
        if (!tStart || !tEnd) return;
        const onInput = e => {
            const a = parseInt(tStart.value), b = parseInt(tEnd.value);
            if (a > b) {
                if (e.target === tStart) tEnd.value = a;
                else                     tStart.value = b;
            }
            goToFrame(parseInt(e.target.value));
            _updateTrimTrack();
        };
        tStart.addEventListener('input', onInput);
        tEnd.addEventListener('input', onInput);
        // Blur after release so space-bar reaches the play/pause shortcut.
        tStart.addEventListener('change', () => tStart.blur());
        tEnd.addEventListener('change',   () => tEnd.blur());
    }

    function seekAndRenderFrame(f) {
        return new Promise(resolve => {
            currentFrame = Math.max(0, Math.min(f, nFrames - 1));
            $('frameDisplay').textContent = currentFrame;
            if (videoEl.readyState >= 2 && fps) {
                videoEl.currentTime = (currentFrame + 0.5) / fps;
                videoEl.addEventListener('seeked', () => { render(); resolve(); }, { once: true });
            } else {
                resolve();
            }
        });
    }

    async function runExport() {
        if (exportRunning) return;
        const tA = parseInt($('trimStart').value);
        const tB = parseInt($('trimEnd').value);
        const startFrame = Math.min(tA, tB);
        const endFrame   = Math.max(tA, tB);
        if (endFrame <= startFrame) { alert('Trim range is empty'); return; }
        const totalFrames = endFrame - startFrame + 1;

        const status = $('exportStatus');
        const btn = $('exportBtn');
        const cancelBtn = $('exportCancelBtn');
        exportRunning = true;
        exportAbortRequested = false;
        exportAbort = new AbortController();
        btn.disabled = true;
        cancelBtn.disabled = false;
        status.textContent = 'Starting…';
        const _checkAbort = () => {
            if (exportAbortRequested) throw new DOMException('Cancelled', 'AbortError');
        };

        const savedFrame = currentFrame;
        const cx = Math.max(0, Math.round(cropX));
        const cy = Math.max(0, Math.round(cropY));
        let cw = Math.min(canvas.width  - cx, Math.round(cropW));
        let ch = Math.min(canvas.height - cy, Math.round(cropH));
        if (cw % 2) cw -= 1;
        if (ch % 2) ch -= 1;

        let exportId = null;
        try {
            const outFps = fps * (playbackRate || 1);

            _checkAbort();
            const startResp = await fetch('/api/export-video/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fps: outFps, width: cw, height: ch, total_frames: totalFrames,
                }),
                signal: exportAbort.signal,
            });
            if (!startResp.ok) throw new Error('start session failed');
            exportId = (await startResp.json()).export_id;

            const offscreen = document.createElement('canvas');
            offscreen.width = cw; offscreen.height = ch;
            const offCtx = offscreen.getContext('2d');
            const BATCH = 100;

            for (let batchStart = startFrame; batchStart <= endFrame; batchStart += BATCH) {
                _checkAbort();
                const batchEnd = Math.min(batchStart + BATCH - 1, endFrame);
                const fd = new FormData();
                fd.append('start_index', batchStart - startFrame);
                for (let f = batchStart; f <= batchEnd; f++) {
                    _checkAbort();
                    await seekAndRenderFrame(f);
                    offCtx.fillStyle = '#000';
                    offCtx.fillRect(0, 0, cw, ch);
                    offCtx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
                    const blob = await new Promise(r => offscreen.toBlob(r, 'image/jpeg', 0.92));
                    const globalIdx = f - startFrame;
                    fd.append(`frame_${f - batchStart}`, blob,
                              `frame_${String(globalIdx).padStart(6, '0')}.jpg`);
                    status.textContent = `Capturing ${f - startFrame + 1} / ${totalFrames}`;
                }
                _checkAbort();
                status.textContent = `Uploading batch…`;
                const upResp = await fetch(`/api/export-video/${exportId}/frames`, {
                    method: 'POST', body: fd, signal: exportAbort.signal,
                });
                if (!upResp.ok) throw new Error('frame upload failed');
            }

            _checkAbort();
            status.textContent = 'Encoding…';
            const encResp = await fetch(`/api/export-video/${exportId}/encode`, {
                method: 'POST', signal: exportAbort.signal,
            });
            if (!encResp.ok) throw new Error('encoding failed');
            const mp4Blob = await encResp.blob();
            const url = URL.createObjectURL(mp4Blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'export.mp4';
            a.textContent = 'Download MP4';
            status.textContent = 'Done.';
            status.appendChild(a);
            exportId = null;
        } catch (err) {
            if (err && err.name === 'AbortError') {
                status.textContent = 'Cancelled.';
                if (exportId) {
                    fetch(`/api/export-video/${exportId}`, { method: 'DELETE' }).catch(() => {});
                }
            } else {
                console.error(err);
                status.textContent = 'Error: ' + err.message;
            }
        } finally {
            exportRunning = false;
            exportAbort = null;
            const wasAborted = exportAbortRequested;
            exportAbortRequested = false;
            btn.disabled = false;
            cancelBtn.disabled = false;
            goToFrame(savedFrame);
            if (wasAborted) exitExportMode();
        }
    }

    // Expose for inline onclick handlers
    window.toggleExportMode = toggleExportMode;
    window.exitExportMode = exitExportMode;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
