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

    /** Format a frame index as "M:SS.mmm" using the current fps. */
    function _fmtTime(frameIdx) {
        if (!fps || !isFinite(frameIdx)) return '0:00.000';
        const sec = frameIdx / fps;
        const m = Math.floor(sec / 60);
        const rem = sec - m * 60;
        const s = Math.floor(rem);
        const ms = Math.round((rem - s) * 1000);
        return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }
    function _refreshTimeDisplay() {
        const td  = $('timeDisplay');
        const ttd = $('totalTimeDisplay');
        if (td)  td.textContent  = _fmtTime(currentFrame);
        if (ttd) ttd.textContent = _fmtTime(Math.max(0, nFrames - 1));
    }

    // ── Recent-videos store (IndexedDB) ────────────────────────
    // Each record: { name, size, stereo, lastUsed, handle? }.  The
    // optional `handle` is a FileSystemFileHandle (Chrome/Edge) that
    // lets us re-open the file later without showing a file picker.
    // Browsers without the File System Access API simply get a record
    // with no handle and fall back to the picker.
    const RecentVideos = (() => {
        const DB_NAME = 'movement_viewer';
        const STORE   = 'recents';
        const KEY     = 'all';
        const MAX     = 10;
        let _db = null;

        function _open() {
            return new Promise((resolve, reject) => {
                if (_db) return resolve(_db);
                const req = indexedDB.open(DB_NAME, 2);
                req.onupgradeneeded = e => {
                    const db = e.target.result;
                    if (db.objectStoreNames.contains('recent_videos')) {
                        // Drop the old (blob-storing) store from the
                        // previous schema — it would just waste quota.
                        db.deleteObjectStore('recent_videos');
                    }
                    if (!db.objectStoreNames.contains(STORE)) {
                        db.createObjectStore(STORE, { keyPath: 'id' });
                    }
                };
                req.onsuccess = e => { _db = e.target.result; resolve(_db); };
                req.onerror   = e => reject(e.target.error);
            });
        }

        async function _readAll() {
            try {
                const db = await _open();
                return await new Promise(resolve => {
                    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
                    req.onsuccess = () => resolve((req.result && req.result.data) || []);
                    req.onerror   = () => resolve([]);
                });
            } catch (_) { return []; }
        }
        async function _writeAll(arr) {
            try {
                const db = await _open();
                await new Promise(resolve => {
                    const tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).put({ id: KEY, data: arr });
                    tx.oncomplete = resolve;
                    tx.onerror    = resolve;   // best-effort
                });
            } catch (_) {}
        }

        async function list() {
            const arr = await _readAll();
            arr.sort((a, b) => b.lastUsed - a.lastUsed);
            return arr;
        }
        async function find(name, size) {
            const arr = await _readAll();
            return arr.find(r => r.name === name && r.size === size) || null;
        }
        async function touch(name, size, stereo, handle) {
            let arr = await _readAll();
            const i = arr.findIndex(r => r.name === name && r.size === size);
            const now = Date.now();
            if (i >= 0) {
                arr[i].lastUsed = now;
                if (stereo !== undefined) arr[i].stereo = !!stereo;
                if (handle)               arr[i].handle = handle;
            } else {
                arr.push({ name, size, stereo: !!stereo, lastUsed: now, handle });
            }
            arr.sort((a, b) => b.lastUsed - a.lastUsed);
            if (arr.length > MAX) arr = arr.slice(0, MAX);
            await _writeAll(arr);
        }
        async function updateStereo(name, size, stereo) {
            const arr = await _readAll();
            const i = arr.findIndex(r => r.name === name && r.size === size);
            if (i >= 0) {
                arr[i].stereo = !!stereo;
                await _writeAll(arr);
            }
        }
        async function remove(name, size) {
            const arr = await _readAll();
            const next = arr.filter(r => !(r.name === name && r.size === size));
            if (next.length !== arr.length) await _writeAll(next);
        }
        return { list, find, touch, updateStereo, remove };
    })();

    // (name, size) of the currently loaded file — used to drive the
    // dropdown selection and to scope stereo-checkbox writes.
    let currentLoaded = null;       // { name, size } or null
    // Set when the user is mid-load via the recents dropdown or via
    // Load Video.  Carries the saved stereo flag and any new
    // FileSystemFileHandle to persist on the next touch().
    let pendingRecent = null;       // { name, size, stereo, handle? } or null

    function _recentKey(r) { return `${r.name}|${r.size}`; }

    function _closeRecentPanel() {
        const panel = $('recentPanel');
        if (panel) panel.hidden = true;
    }
    function _toggleRecentPanel() {
        const panel = $('recentPanel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
    }

    async function _refreshRecentDropdown() {
        const toggle = $('recentToggleBtn');
        const label  = $('recentLabel');
        const panel  = $('recentPanel');
        if (!toggle || !label || !panel) return;
        const recs = await RecentVideos.list();

        // Toggle label + disabled state
        if (recs.length === 0) {
            label.textContent = 'No recent videos';
            toggle.disabled = true;
            panel.innerHTML = '';
            panel.hidden = true;
            return;
        }
        toggle.disabled = false;
        const curKey = currentLoaded ? _recentKey(currentLoaded) : null;
        const cur = curKey ? recs.find(r => _recentKey(r) === curKey) : null;
        // Before a video is loaded, show "Load Recent" instead of the
        // most-recent filename — makes the action discoverable on first
        // run and the label only shows a real title once one is open.
        label.textContent = cur ? cur.name : 'Load Recent';

        // Rebuild the rows.  The currently loaded entry doesn't get a
        // remove (×) button — protects against deleting the row that
        // matches the video you're watching.
        panel.innerHTML = '';
        for (const r of recs) {
            const isCurrent = curKey === _recentKey(r);
            const row = document.createElement('div');
            row.className = 'recent-row' + (isCurrent ? ' current' : '');
            row.dataset.key = _recentKey(r);
            row.innerHTML =
                `<span class="recent-name"></span>` +
                (isCurrent ? '' : `<button type="button" class="recent-x" title="Remove from list">×</button>`);
            row.querySelector('.recent-name').textContent = r.name;
            row.addEventListener('click', e => {
                if (e.target.closest('.recent-x')) return;   // X handled separately
                _closeRecentPanel();
                _loadFromRecent(row.dataset.key);
            });
            const xBtn = row.querySelector('.recent-x');
            if (xBtn) {
                xBtn.addEventListener('click', async e => {
                    e.stopPropagation();
                    await RecentVideos.remove(r.name, r.size);
                    _refreshRecentDropdown();
                });
            }
            panel.appendChild(row);
        }
    }

    // User picked an entry from the dropdown.  If we have a stored
    // FileSystemFileHandle, re-open the file directly (one-time
    // permission prompt the first time per browser session).  Otherwise
    // fall back to the file picker — same name/size match restores the
    // saved stereo flag.
    async function _loadFromRecent(keyStr) {
        if (!keyStr) return;
        const [name, sizeStr] = keyStr.split('|');
        const size = parseInt(sizeStr);
        const rec = await RecentVideos.find(name, size);
        if (!rec) return;

        if (rec.handle) {
            try {
                if (typeof rec.handle.queryPermission === 'function') {
                    let perm = await rec.handle.queryPermission({ mode: 'read' });
                    if (perm !== 'granted') {
                        perm = await rec.handle.requestPermission({ mode: 'read' });
                    }
                    if (perm !== 'granted') {
                        alert('Read permission was denied for that file.');
                        return;
                    }
                }
                const file = await rec.handle.getFile();
                pendingRecent = {
                    name: rec.name, size: rec.size,
                    stereo: rec.stereo, handle: rec.handle,
                };
                loadFile(file);
                return;
            } catch (err) {
                // File moved / renamed / deleted on disk → fall back.
                console.warn('Re-open via stored handle failed:', err);
            }
        }
        pendingRecent = { name: rec.name, size: rec.size, stereo: rec.stereo };
        $('browseInput').click();
    }

    // IDs of controls that should only be active once a video is loaded.
    const _GATED_IDS = [
        'timelineSlider', 'prevFrameBtn', 'playBtn', 'nextFrameBtn',
        'speedSlider', 'sideToggle', 'resetZoomBtn',
        'exportBtn', 'stereoCheckbox',
        // recentToggleBtn is gated separately by _refreshRecentDropdown
        // (enabled iff there's at least one recent entry).
    ];
    function _setLoaded(loaded) {
        for (const id of _GATED_IDS) {
            const el = document.getElementById(id);
            if (el) el.disabled = !loaded;
        }
    }

    // ── Init ────────────────────────────────────────────────
    function init() {
        // Clean up vestigial data from earlier versions of the app —
        // the current code only persists metadata in IndexedDB.
        try { localStorage.removeItem('movement_viewer_recents'); } catch (_) {}

        canvas = $('canvas');
        ctx = canvas.getContext('2d');
        videoEl = document.createElement('video');
        videoEl.muted = true;
        setupControls();
        setupCanvasEvents();
        _wireTrimHandles();
        sizeCanvas();
        render();
        _refreshRecentDropdown();
    }

    // ── File loading ─────────────────────────────────────────
    async function loadFile(file) {
        if (!file) return;
        // Saved-stereo + handle lookup.  pendingRecent (set by either
        // the recents-dropdown handler or by the showOpenFilePicker
        // pick) wins; then a direct DB lookup by (name, size); else
        // null + size heuristic.
        let savedStereo = null;
        let savedHandle = null;
        if (pendingRecent &&
            pendingRecent.name === file.name &&
            pendingRecent.size === file.size) {
            savedStereo = pendingRecent.stereo;
            savedHandle = pendingRecent.handle || null;
        }
        if (savedStereo === null || savedStereo === undefined) {
            savedStereo = null;
            const rec = await RecentVideos.find(file.name, file.size);
            if (rec) {
                savedStereo = rec.stereo;
                if (!savedHandle && rec.handle) savedHandle = rec.handle;
            }
        }
        pendingRecent = null;
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
            // Stereo flag: use the per-file saved preference if we've
            // seen this file before; otherwise fall back to the
            // aspect-ratio heuristic (≥ 2:1 = side-by-side).
            const stereoFlag = (savedStereo !== null)
                ? savedStereo
                : (vidW >= 2 * vidH);
            $('stereoCheckbox').checked = stereoFlag;
            isStereo = stereoFlag;
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
            _refreshTimeDisplay();
            $('dropHint').classList.add('hidden');
            _setLoaded(true);
            sizeCanvas();
            // Persist this file's metadata (and FileSystemFileHandle if
            // we have one) so the dropdown can re-open it directly next
            // time.  Then refresh the dropdown to put it at the top.
            currentLoaded = { name: file.name, size: file.size };
            RecentVideos.touch(file.name, file.size, isStereo, savedHandle)
                        .then(_refreshRecentDropdown);
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

        $('browseBtn').addEventListener('click', async () => {
            pendingRecent = null;
            // Prefer the File System Access API so the next time the
            // user picks this file from the recents dropdown we can
            // re-open it without showing a picker again.
            if (window.showOpenFilePicker) {
                try {
                    const [handle] = await window.showOpenFilePicker({
                        multiple: false,
                        types: [{
                            description: 'Videos',
                            accept: {
                                'video/*': ['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi'],
                            },
                        }],
                    });
                    const file = await handle.getFile();
                    pendingRecent = {
                        name: file.name, size: file.size,
                        stereo: undefined, handle,
                    };
                    loadFile(file);
                    return;
                } catch (err) {
                    if (err && err.name === 'AbortError') return;
                    console.warn('showOpenFilePicker failed, falling back:', err);
                }
            }
            $('browseInput').click();
        });
        $('browseInput').addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) loadFile(file);
            e.target.value = '';
        });

        // Recent-videos picker — toggle on click, close on outside click.
        $('recentToggleBtn').addEventListener('click', e => {
            e.stopPropagation();
            _toggleRecentPanel();
        });
        document.addEventListener('click', e => {
            if (!$('recentPicker').contains(e.target)) _closeRecentPanel();
        });

        $('stereoCheckbox').addEventListener('change', e => {
            isStereo = !!e.target.checked;
            midline = isStereo ? Math.round(vidW / 2) : vidW;
            currentSide = cameraNames[0];
            currentCameraIdx = 0;
            updateCameraButton();
            scale = 1; offsetX = 0; offsetY = 0;
            render();
            // Remember the user's choice for this specific file.
            if (currentLoaded) {
                RecentVideos.updateStereo(currentLoaded.name, currentLoaded.size, isStereo);
            }
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
            if (!playing) return;
            // Cancel whichever play mode is currently running, then
            // re-enter the one that matches the new rate.  Without this
            // a slow→fast change keeps the manual stepper (jittery) and
            // a fast→slow change keeps native playback (too fast).
            if (playTimer) {
                if (typeof playTimer === 'number') clearTimeout(playTimer);
                else cancelAnimationFrame(playTimer);
                playTimer = null;
            }
            if (playbackRate >= 0.0625) {
                videoEl.playbackRate = Math.min(playbackRate, 16);
                if (videoEl.paused) videoEl.play().catch(() => {});
                playLoop();
            } else {
                videoEl.pause();
                playStepManual();
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
            const isActive = (name === currentSide);
            const cls = 'cam-half ' + (isActive ? 'active' : 'inactive');
            const inline = isActive ? act : ina;
            const span = `<span class="${cls}" style="${inline}">${name}</span>`;
            const sep = (i < opts.length - 1)
                ? `<span class="cam-sep">|</span>` : '';
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
        _refreshTimeDisplay();
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
                _refreshTimeDisplay();
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
            // Export-mode: crop-box handles win.  Clicking inside the
            // box (no handle) falls through to pan — the crop frame
            // stays fixed on screen and the video shifts beneath it.
            if (exportMode) {
                const { mx, my } = _bufXY(e);
                const hit = _cropHitTest(mx, my);
                if (hit && hit !== 'move') {
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

                // Corner handles (nw/ne/sw/se) keep aspect ratio.
                // Side handles (n/s/e/w) change it freely.
                const isCorner = (cropDragMode.length === 2);
                if (isCorner) {
                    const aspect = s.w / s.h;
                    // The opposite corner is the anchor — it stays put.
                    let anchorX, anchorY;
                    if      (cropDragMode === 'se') { anchorX = s.x;       anchorY = s.y;       }
                    else if (cropDragMode === 'sw') { anchorX = s.x + s.w; anchorY = s.y;       }
                    else if (cropDragMode === 'ne') { anchorX = s.x;       anchorY = s.y + s.h; }
                    else /* nw */                   { anchorX = s.x + s.w; anchorY = s.y + s.h; }

                    let newW = Math.abs(mx - anchorX);
                    let newH = Math.abs(my - anchorY);
                    if (newW / newH > aspect) { newW = newH * aspect; }
                    else                      { newH = newW / aspect; }

                    // Clamp against the visible video rect (the corner
                    // can only grow toward bounds in the direction of
                    // the dragged handle).
                    const maxW = (cropDragMode.includes('e'))
                        ? (r.right - anchorX)
                        : (anchorX - r.left);
                    const maxH = (cropDragMode.includes('s'))
                        ? (r.bot - anchorY)
                        : (anchorY - r.top);
                    if (newW > maxW) { newW = maxW; newH = newW / aspect; }
                    if (newH > maxH) { newH = maxH; newW = newH * aspect; }

                    if (newW < minSize) { newW = minSize; newH = minSize / aspect; }
                    if (newH < minSize) { newH = minSize; newW = minSize * aspect; }

                    cropW = newW; cropH = newH;
                    cropX = (cropDragMode.includes('e')) ? anchorX : anchorX - newW;
                    cropY = (cropDragMode.includes('s')) ? anchorY : anchorY - newH;
                } else {
                    let nx = s.x, ny = s.y, nw = s.w, nh = s.h;
                    if (cropDragMode === 'w') {
                        nx = Math.max(r.left, Math.min(s.x + s.w - minSize, s.x + dx));
                        nw = s.x + s.w - nx;
                    } else if (cropDragMode === 'e') {
                        nw = Math.max(minSize, Math.min(r.right - s.x, s.w + dx));
                    } else if (cropDragMode === 'n') {
                        ny = Math.max(r.top, Math.min(s.y + s.h - minSize, s.y + dy));
                        nh = s.y + s.h - ny;
                    } else if (cropDragMode === 's') {
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
        // No 'move' case — interior clicks pan the underlying video,
        // so leave the cursor default there.
        switch (hit) {
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
        // In the kept region (between handles) show the crop accent
        // green; outside, match the regular timeline's light-grey
        // track so it reads as "trimmed away".
        const GREY = '#c5c5c5';
        track.style.background =
            `linear-gradient(to right,
                ${GREY} 0%, ${GREY} ${aP}%,
                ${CROP_COLOR} ${aP}%, ${CROP_COLOR} ${bP}%,
                ${GREY} ${bP}%, ${GREY} 100%)`;
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
            _refreshTimeDisplay();
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

        // Prompt for the save destination FIRST — while the user
        // activation from the Export click is still valid.  If the
        // user cancels we never touch the server.
        if (!window.showSaveFilePicker) {
            alert('Saving the export needs Chrome or Edge (File System Access API).');
            return;
        }
        const stem = (currentLoaded && currentLoaded.name)
            ? currentLoaded.name.replace(/\.\w+$/, '')
            : 'export';
        let saveHandle = null;
        try {
            saveHandle = await window.showSaveFilePicker({
                suggestedName: `${stem}_clip.mp4`,
                types: [{
                    description: 'MP4 video',
                    accept: { 'video/mp4': ['.mp4'] },
                }],
            });
        } catch (err) {
            if (err && err.name === 'AbortError') return;     // user cancelled
            alert('Could not open save dialog: ' + err.message);
            return;
        }

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
            // Write straight to the file the user picked — no blob URL,
            // no download link, no in-memory copy past this point.
            status.textContent = 'Saving…';
            _checkAbort();
            const writable = await saveHandle.createWritable();
            await writable.write(mp4Blob);
            await writable.close();
            status.textContent = `Saved to ${saveHandle.name}.`;
            saveHandle = null;          // committed → don't delete on cleanup
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
            // Either way, an incomplete (possibly zero-byte) file may
            // exist at the chosen path because showSaveFilePicker
            // creates it on dialog confirmation.  Best-effort remove.
            if (saveHandle && typeof saveHandle.remove === 'function') {
                try { await saveHandle.remove(); } catch (_) {}
            }
            saveHandle = null;
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
