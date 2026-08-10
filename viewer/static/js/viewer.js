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
    // Maximum number of speeds queued for a single export.  Bound by
    // CPU cores — past 4 the parallel encodes start contending.
    const MAX_EXPORT_SPEEDS = 4;
    // Ordered queue of {speed, badge} for the next export.  Empty
    // means "use the current slider speed at export time".
    let exportSpeedQueue = [];
    let currentVideoUrl = null;

    // Transport-glyph rendering differs by OS: Windows draws unicode ←/→
    // as hairlines and ▮▮ as chunky blocks.  Use SVG icons on Windows so
    // they match the (already-nice) Mac unicode rendering; leave Mac on
    // its native glyphs.  Play (▶) renders fine on both, so unicode wins.
    const _isWindows = /Win/i.test(navigator.platform) ||
                       /Windows/i.test(navigator.userAgent);
    const _SVG_LEFT  = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block;"><path d="M19 12 H5 M11 6 L5 12 L11 18"/></svg>`;
    const _SVG_RIGHT = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block;"><path d="M5 12 H19 M13 6 L19 12 L13 18"/></svg>`;
    const _SVG_PAUSE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle;display:inline-block;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
    const PLAY_HTML  = '&#9654;';
    const PAUSE_HTML = _isWindows ? _SVG_PAUSE : '&#9646;&#9646;';
    const PREV_HTML  = _isWindows ? _SVG_LEFT  : '&#8592;';
    const NEXT_HTML  = _isWindows ? _SVG_RIGHT : '&#8594;';

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
    // Empirically-derived alignment pan (OS→OD), in source-image pixels.
    // Median across 91 stereo trials in the movement-tracker dataset of
    // (OD MediaPipe-hand-center − OS MediaPipe-hand-center).  Adding the
    // negation of this delta to offsetX/offsetY on switch makes the same
    // hand land at roughly the same canvas position in both views.
    const MP_SWITCH_PAN = { dx: 109, dy: 18 };

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

    /** Format a frame index as "M:SS.cc" (2-digit centisecond) using the current fps. */
    function _fmtTime(frameIdx) {
        if (!fps || !isFinite(frameIdx)) return '0:00.00';
        const sec = frameIdx / fps;
        const m = Math.floor(sec / 60);
        const rem = sec - m * 60;
        const s = Math.floor(rem);
        const cs = Math.round((rem - s) * 100);
        // Roll over if hundredths round up to 100.
        const cs2 = cs === 100 ? 0 : cs;
        const s2  = cs === 100 ? s + 1 : s;
        return `${m}:${String(s2).padStart(2, '0')}.${String(cs2).padStart(2, '0')}`;
    }
    function _refreshTimeDisplay() {
        const td  = $('timeDisplay');
        const ttd = $('totalTimeDisplay');
        if (td)  td.textContent  = _fmtTime(currentFrame);
        if (ttd) ttd.textContent = _fmtTime(Math.max(0, nFrames - 1));
    }

    /** Resize the time/frame counter boxes so they fit the last frame's
     *  values exactly (no slack at the max).  Called once per loaded
     *  video. */
    function _updateCounterWidths() {
        const lastFrame   = Math.max(0, nFrames - 1);
        const frameDigits = String(lastFrame).length;
        const lastTime    = _fmtTime(lastFrame);           // e.g. "0:59.99"
        const timeChars   = lastTime.length;
        const r = document.documentElement.style;
        r.setProperty('--time-w',        `${timeChars}ch`);
        r.setProperty('--frame-w',       `${6 + frameDigits}ch`);   // "Frame " + N
        r.setProperty('--total-frame-w', `${frameDigits}ch`);
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
    // The loaded File object itself — export uploads its raw bytes to
    // the server once (cached there) so ffmpeg can encode directly.
    let currentFile = null;
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

        // Rebuild the rows.  Every entry — including the currently
        // loaded one — gets a remove (×) button.  Removing the current
        // entry additionally returns the page to its empty state.
        panel.innerHTML = '';
        for (const r of recs) {
            const isCurrent = curKey === _recentKey(r);
            const row = document.createElement('div');
            row.className = 'recent-row' + (isCurrent ? ' current' : '');
            row.dataset.key = _recentKey(r);
            row.innerHTML =
                `<span class="recent-name"></span>` +
                `<button type="button" class="recent-x" title="Remove from list">×</button>`;
            row.querySelector('.recent-name').textContent = r.name;
            row.addEventListener('click', e => {
                if (e.target.closest('.recent-x')) return;   // X handled separately
                _closeRecentPanel();
                _loadFromRecent(row.dataset.key);
            });
            row.querySelector('.recent-x').addEventListener('click', async e => {
                e.stopPropagation();
                if (isCurrent) _unloadVideo();
                await RecentVideos.remove(r.name, r.size);
                _refreshRecentDropdown();
            });
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

    /** Restore the page to its empty / "no video loaded" state. */
    function _unloadVideo() {
        if (playing) togglePlay();
        if (exportMode) exitExportMode();
        if (videoEl) {
            try {
                videoEl.pause();
                videoEl.removeAttribute('src');
                videoEl.load();
            } catch (_) {}
        }
        vidW = 0; vidH = 0; midline = 0;
        isStereo = false;
        nFrames = 0;
        fps = 30;
        currentFrame = 0;
        scale = 1; offsetX = 0; offsetY = 0;
        currentLoaded = null;
        if (currentVideoUrl) { try { URL.revokeObjectURL(currentVideoUrl); } catch (_) {} currentVideoUrl = null; }
        pendingRecent = null;
        $('frameDisplay').textContent = 0;
        $('totalFramesDisplay').textContent = 0;
        $('timelineSlider').value = 0;
        $('timelineSlider').max = 1000;
        $('stereoCheckbox').checked = false;
        _refreshTimeDisplay();
        _setLoaded(false);
        updateCameraButton();
        render();
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

        // Swap the unicode prev/next glyphs for SVGs on Windows (no-op
        // on Mac — both consts hold the same unicode entities there).
        $('prevFrameBtn').innerHTML = PREV_HTML;
        $('nextFrameBtn').innerHTML = NEXT_HTML;
        setupControls();
        setupCanvasEvents();
        _wireTrimHandles();
        sizeCanvas();
        render();
        _refreshRecentDropdown();
        _autoLoadMostRecent();
    }

    /** Try to load the most-recently-used video on launch.  If
     *  ``queryPermission`` already reports ``granted`` the file is
     *  opened silently; otherwise we attempt ``requestPermission``,
     *  and if that throws (no user gesture on pageload) we surface a
     *  one-click "Resume <name>" banner that retries inside the
     *  click's user-activation window. */
    async function _autoLoadMostRecent() {
        try {
            const recs = await RecentVideos.list();
            if (!recs.length) return;
            const rec = recs[0];
            const h = rec && rec.handle;
            if (!h) return;

            const openWith = async (handle) => {
                const file = await handle.getFile();
                pendingRecent = {
                    name: rec.name, size: rec.size,
                    stereo: rec.stereo, handle: handle,
                };
                loadFile(file);
            };

            let perm = 'prompt';
            if (typeof h.queryPermission === 'function') {
                try { perm = await h.queryPermission({ mode: 'read' }); } catch (_) {}
            }
            if (perm === 'granted') {
                await openWith(h);
                return;
            }

            // No grant yet.  Try requestPermission immediately — some
            // browsers allow it during page load if the handle was
            // recently used; others throw SecurityError because there's
            // no transient user activation.
            try {
                if (typeof h.requestPermission === 'function') {
                    const granted = await h.requestPermission({ mode: 'read' });
                    if (granted === 'granted') {
                        await openWith(h);
                        return;
                    }
                }
            } catch (_) { /* fall through to the click affordance */ }

            // Fall back to a one-click banner so the next user gesture
            // can re-request permission successfully.
            _showResumeBanner(rec, openWith);
        } catch (err) {
            console.warn('Auto-load of most recent video failed:', err);
        }
    }

    /** Floating "Resume <name>" affordance for when auto-load needed
     *  a permission re-grant that the browser refused without a user
     *  gesture.  Clicking it requests permission inside the click's
     *  activation window, then opens the file. */
    function _showResumeBanner(rec, openWith) {
        const existing = document.getElementById('resumeBanner');
        if (existing) existing.remove();
        const btn = document.createElement('button');
        btn.id = 'resumeBanner';
        btn.type = 'button';
        btn.style.cssText = (
            'position:fixed;top:10px;left:50%;transform:translateX(-50%);' +
            'z-index:1000;padding:6px 12px;font-size:12px;' +
            'background:var(--violet-bright);color:#fff;border:none;' +
            'border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,0.35);' +
            'cursor:pointer;'
        );
        btn.textContent = `Resume ${rec.name}`;
        btn.addEventListener('click', async () => {
            try {
                const granted = await rec.handle.requestPermission({ mode: 'read' });
                if (granted !== 'granted') return;
                btn.remove();
                await openWith(rec.handle);
            } catch (err) {
                console.warn('Resume failed:', err);
                btn.textContent = 'Resume failed — pick from Recent list';
            }
        });
        document.body.appendChild(btn);
        // Auto-dismiss after 30s so it doesn't linger forever.
        setTimeout(() => { try { btn.remove(); } catch (_) {} }, 30000);
    }

    // ── File loading ─────────────────────────────────────────
    async function loadFile(file) {
        if (!file) return;
        // Switching videos invalidates whatever was being set up in
        // export mode (trim ranges, crop window, possibly an in-flight
        // export).  Drop out of export mode — and abort any running
        // export — before swapping the source video.
        if (exportMode) exitExportMode();
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

        if (currentVideoUrl) { try { URL.revokeObjectURL(currentVideoUrl); } catch (_) {} }
        const url = URL.createObjectURL(file);
        currentVideoUrl = url;
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
            _updateCounterWidths();
            _refreshTimeDisplay();
            _setLoaded(true);
            sizeCanvas();
            // Persist this file's metadata (and FileSystemFileHandle if
            // we have one) so the dropdown can re-open it directly next
            // time.  Then refresh the dropdown to put it at the top.
            currentLoaded = { name: file.name, size: file.size };
            currentFile = file;
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

        // "Add speed" button — queues the slider's current speed for
        // the next export.  Re-labels to "Set speed" + dims when that
        // speed is already queued.
        $('addSpeedBtn').addEventListener('click', () => {
            if (exportSpeedQueue.some(e => e.speed === playbackRate)) return;
            if (exportSpeedQueue.length >= MAX_EXPORT_SPEEDS) return;
            exportSpeedQueue.push({ speed: playbackRate, badge: false });
            _renderSpeedTags();
            _updateAddSpeedBtn();
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
            _updateAddSpeedBtn();
            if (exportMode) render();
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
        const prevWasOS = (currentSide === cameraNames[0]);
        currentCameraIdx = (currentCameraIdx + 1) % 2;
        currentSide = cameraNames[currentCameraIdx];
        updateCameraButton();
        // Apply the empirical OS↔OD pan so the same hand stays at
        // roughly the same canvas position.  Sign is + on OS→OD, − on
        // OD→OS.  Image-pixel offsets are scaled by bps × scale to
        // become canvas-pixel offsets.
        const { bps } = getBaseMetrics();
        if (bps > 0) {
            const sign = prevWasOS ? +1 : -1;
            offsetX += sign * MP_SWITCH_PAN.dx * bps * scale;
            offsetY += sign * MP_SWITCH_PAN.dy * bps * scale;
        }
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
            $('playBtn').innerHTML = PLAY_HTML;
        } else {
            playing = true;
            $('playBtn').innerHTML = PAUSE_HTML;
            if (playbackRate >= 0.0625) {
                // Make sure the underlying <video> is at currentFrame
                // before resuming playback — otherwise a still-pending
                // seek (e.g. from a trim-slider drag) can cause the
                // browser to start playing from the old time.
                videoEl.playbackRate = Math.min(playbackRate, 16);
                const target = fps ? (currentFrame + 0.5) / fps : 0;
                const start = () => {
                    if (!playing) return;
                    videoEl.play().catch(() => {});
                    playLoop();
                };
                if (fps && Math.abs(videoEl.currentTime - target) > 1e-4) {
                    videoEl.addEventListener('seeked', start, { once: true });
                    videoEl.currentTime = target;
                } else {
                    start();
                }
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
        if (canvas.width === vp.clientWidth &&
            canvas.height === vp.clientHeight) return;
        // The crop box is stored in canvas pixels but means a region of
        // the VIDEO — when the canvas resizes (window resize, control
        // bar wrapping to a second line) the video re-fits, so remap the
        // box through source coords to keep it glued to the same
        // content.  Pan/zoom deliberately do NOT move the box; only
        // resizes remap it.
        const before = getBaseMetrics();
        canvas.width  = vp.clientWidth;
        canvas.height = vp.clientHeight;
        if (cropW > 0 && cropH > 0 && before.bps > 0) {
            const after = getBaseMetrics();
            if (after.bps > 0) {
                const r = after.bps / before.bps;
                cropX = after.baseOX + offsetX
                      + (cropX - before.baseOX - offsetX) * r;
                cropY = after.baseOY + offsetY
                      + (cropY - before.baseOY - offsetY) * r;
                cropW *= r;
                cropH *= r;
            }
        }
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

    /** True when the current crop window covers the entire source frame
     *  (or the entire active half, for stereo) — i.e. the export would
     *  contain the same pixels as just feeding the source through ffmpeg
     *  with no crop.  Used to decide whether to add a "_Crop" tag in
     *  the suggested export filename. */
    function _cropIsFullSource() {
        const { bps, baseOX, baseOY, sw } = getBaseMetrics();
        if (!(bps > 0) || !(vidH > 0) || !(sw > 0)) return true;
        const denom = bps * scale;
        if (!(denom > 0)) return true;
        // Crop expressed in source-image pixels (top-left at 0,0 of
        // whichever half is currently shown).
        const ix = (cropX - baseOX - offsetX) / denom;
        const iy = (cropY - baseOY - offsetY) / denom;
        const iw = cropW / denom;
        const ih = cropH / denom;
        const TOL = 2;     // source-pixel tolerance
        return Math.abs(ix)        < TOL &&
               Math.abs(iy)        < TOL &&
               Math.abs(iw - sw)   < TOL &&
               Math.abs(ih - vidH) < TOL;
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
        _drawCropOverlay();         // visible only when not capturing
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

    /** Re-render the row of queued-speed pills.  Each queued speed
     *  becomes a {pill ×}{print} pair: the pill itself shows just
     *  ``Nx`` and a remove ×, with a small ``print`` checkbox sitting
     *  inline beside it (outside the pill border) that toggles the
     *  burned-in 'Nx' badge for THAT speed's output.  Removing the
     *  pill also removes the print checkbox in the same DOM group. */
    function _renderSpeedTags() {
        const row = $('exportSpeedTags');
        if (!row) return;
        row.innerHTML = '';
        for (let i = 0; i < exportSpeedQueue.length; i++) {
            const entry = exportSpeedQueue[i];
            const group = document.createElement('span');
            group.className = 'speed-tag-group';
            group.dataset.idx = String(i);

            const tag = document.createElement('span');
            tag.className = 'speed-tag';
            const rate = document.createElement('span');
            rate.className = 'tag-rate';
            rate.textContent = `${entry.speed}x`;
            tag.appendChild(rate);
            const rm = document.createElement('button');
            rm.className = 'tag-remove';
            rm.type = 'button';
            rm.textContent = '×';
            rm.title = 'Remove this speed';
            rm.addEventListener('click', () => {
                exportSpeedQueue.splice(i, 1);
                _renderSpeedTags();
                _updateAddSpeedBtn();
            });
            tag.appendChild(rm);
            group.appendChild(tag);

            const printLbl = document.createElement('label');
            printLbl.className = 'tag-print';
            printLbl.title = `Burn a "${entry.speed}x" label into the top-left of this output`;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!entry.badge;
            cb.addEventListener('change', () => {
                entry.badge = cb.checked;
                // Re-render so the checked label picks up the lime
                // active style without us having to track it.
                _renderSpeedTags();
            });
            printLbl.appendChild(cb);
            printLbl.appendChild(document.createTextNode('print'));
            group.appendChild(printLbl);

            row.appendChild(group);
        }
    }

    /** "Add speed" button — dims and reads "Set speed" when the
     *  current slider value is already queued (or queue is at cap). */
    function _updateAddSpeedBtn() {
        const btn = $('addSpeedBtn');
        if (!btn) return;
        const queued = exportSpeedQueue.some(e => e.speed === playbackRate);
        const atCap  = exportSpeedQueue.length >= MAX_EXPORT_SPEEDS;
        const dim = queued || atCap;
        btn.textContent = queued ? 'Set speed' : 'Add speed';
        btn.classList.toggle('dim', dim);
        btn.disabled = dim || exportRunning;
        btn.title = atCap
            ? `At most ${MAX_EXPORT_SPEEDS} speeds per export — remove one first`
            : (queued
                ? 'This speed is already queued — change the slider to add another'
                : 'Queue the current speed for the next export');
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
        // Keep timelineSlider visible — its thumb stays as the
        // current-frame indicator on top of the trim UI.  CSS hides
        // its track and disables pointer events in export mode.
        $('trimUI').style.display = '';
        _updateTrimTrack();
        const btn = $('exportBtn');
        btn.textContent = 'Export';
        btn.classList.add('btn-primary');
        $('exportCancelBtn').style.display = '';
        $('exportStatus').textContent = '';
        _renderSpeedTags();
        _updateAddSpeedBtn();
        _resetCropToView();
        render();
    }

    function exitExportMode() {
        if (exportRunning) { _cancelRunningExport(); return; }
        exportMode = false;
        document.body.classList.remove('export-mode');
        $('trimUI').style.display = 'none';
        const btn = $('exportBtn');
        btn.textContent = 'Export Video';
        btn.classList.remove('btn-primary');
        btn.disabled = false;
        $('exportCancelBtn').style.display = 'none';
        $('exportStatus').textContent = '';
        $('addSpeedBtn').style.display = 'none';
        $('exportSpeedTags').style.display = 'none';
        $('exportSpeedTags').innerHTML = '';
        $('exportFrameStampRow').style.display = 'none';
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

    // Upload the source video's raw bytes with progress.  XHR because
    // fetch() has no upload-progress events.
    function _uploadSource(file, key, statusEl) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = `/api/export-video/source/upload?key=${encodeURIComponent(key)}`
                      + `&name=${encodeURIComponent(file.name)}`;
            xhr.open('POST', url);
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round(e.loaded / e.total * 100);
                    statusEl.textContent = `Uploading source… ${pct}%`;
                }
            };
            xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
                ? resolve()
                : reject(new Error(`source upload failed (${xhr.status})`));
            xhr.onerror = () => reject(new Error('source upload failed'));
            xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
            if (exportAbort) {
                exportAbort.signal.addEventListener('abort', () => xhr.abort(),
                                                    { once: true });
            }
            statusEl.textContent = 'Uploading source…';
            xhr.send(file);
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

        // Resolve the speed queue.  Empty → use the slider's current
        // speed (with no badge).  Ascending order so output files line
        // up with the displayed tags.
        let queue = exportSpeedQueue.slice();
        if (!queue.length) queue = [{ speed: playbackRate, badge: false }];
        queue.sort((a, b) => a.speed - b.speed);
        if (queue.length > MAX_EXPORT_SPEEDS) queue = queue.slice(0, MAX_EXPORT_SPEEDS);
        const speeds = queue.map(q => q.speed);

        // Prompt for save destinations FIRST — one per speed, all
        // chained off the single Export click's user activation.  If
        // the user cancels any picker we never touch the server.
        if (!window.showSaveFilePicker) {
            alert('Saving the export needs Chrome or Edge (File System Access API).');
            return;
        }
        const stem = (currentLoaded && currentLoaded.name)
            ? currentLoaded.name.replace(/\.\w+$/, '')
            : 'export';
        const camTag   = isStereo ? `_${currentSide}` : '';
        const cropTag  = _cropIsFullSource() ? '' : '_crop';
        const isFullRange = (startFrame === 0 && endFrame === nFrames - 1);
        const trimTag  = isFullRange ? '' : `_trim${startFrame}-${endFrame}`;
        const speedTag = (sp) => (sp === 1) ? '' : `_${sp}x`;

        const saveHandles = [];  // parallel to `queue`
        try {
            for (const q of queue) {
                const name = `${stem}${camTag}${cropTag}${speedTag(q.speed)}${trimTag}.mp4`;
                const h = await window.showSaveFilePicker({
                    suggestedName: name,
                    types: [{ description: 'MP4 video',
                              accept: { 'video/mp4': ['.mp4'] } }],
                });
                saveHandles.push(h);
            }
        } catch (err) {
            if (err && err.name === 'AbortError') {
                for (const h of saveHandles) {
                    if (h && typeof h.remove === 'function') {
                        try { await h.remove(); } catch (_) {}
                    }
                }
                return;
            }
            alert('Could not open save dialog: ' + err.message);
            return;
        }

        // The job is committed — clear the queued tags from the UI so
        // the user doesn't think they're still pending for the next
        // export.  Tags are gone, but `queue` (local copy) drives the
        // job below.
        exportSpeedQueue = [];
        _renderSpeedTags();
        _updateAddSpeedBtn();

        const status = $('exportStatus');
        const btn = $('exportBtn');
        const cancelBtn = $('exportCancelBtn');
        exportRunning = true;
        exportAbortRequested = false;
        exportAbort = new AbortController();
        btn.disabled = true;
        cancelBtn.disabled = false;
        // While the job is in flight, the configuration affordances
        // shouldn't change — hide Add/Set speed and the global
        // frame#/time stamp checkboxes.  They reappear when the job
        // finishes (or is cancelled) below.
        $('addSpeedBtn').style.display = 'none';
        $('exportFrameStampRow').style.display = 'none';
        status.textContent = 'Starting…';
        const _checkAbort = () => {
            if (exportAbortRequested) throw new DOMException('Cancelled', 'AbortError');
        };

        // Crop rectangle, captured before the user is free to roam.
        // Deliberately NOT clamped to the canvas: the box is the user's
        // framing of the VIDEO, and the server pads anything outside the
        // frame — clamping to the (resizable) canvas would clip one
        // dimension and change the output's shape.
        const cx = Math.round(cropX);
        const cy = Math.round(cropY);
        const cw = Math.round(cropW);
        const ch = Math.round(cropH);

        // Project the on-screen crop rect into source pixels — ffmpeg
        // crops the ORIGINAL video server-side, so exports come out at
        // native source resolution (no canvas resample).  The video pans
        // and zooms freely beneath the fixed crop frame, so the box may
        // overhang the frame; the export keeps the BOX's shape — the
        // in-frame part is cropped and any overhang is padded black,
        // exactly as drawn on screen.
        const srcW = isStereo ? Math.round(vidW / 2) : vidW;
        const srcH = vidH;
        const { bps, baseOX, baseOY } = getBaseMetrics();
        const denom = scale * bps;
        // Box in source-half pixels, unclamped.  Even-aligned so the
        // crop/pad geometry stays chroma-safe for yuv420.
        const bx = Math.round((cx - baseOX - offsetX) / denom) & ~1;
        const by = Math.round((cy - baseOY - offsetY) / denom) & ~1;
        const bw = Math.max(2, Math.round(cw / denom)) & ~1;
        const bh = Math.max(2, Math.round(ch / denom)) & ~1;
        // Visible part of the box: its intersection with the frame.
        const ix = Math.max(0, bx);
        const iy = Math.max(0, by);
        const iw = (Math.min(srcW, bx + bw) - ix) & ~1;
        const ih = (Math.min(srcH, by + bh) - iy) & ~1;
        // Stereo: shift the crop into the requested half of the full frame.
        const sxFull = isStereo && currentSide !== cameraNames[0] ? srcW : 0;
        const cropBody = {
            x: sxFull + ix, y: iy, w: iw, h: ih,
            pad_w: bw, pad_h: bh, pad_x: ix - bx, pad_y: iy - by,
        };

        let exportId = null;
        let handlesToCleanup = [...saveHandles];
        try {
            _checkAbort();
            if (iw < 2 || ih < 2) {
                throw new Error('crop box is entirely outside the video frame — pan the video back under it');
            }
            if (!currentFile) {
                throw new Error('source file unavailable — reload the video');
            }
            // Upload the source once; the server caches it by
            // name+size+mtime so later exports of the same file skip this.
            const srcKey = `${currentFile.name}|${currentFile.size}|${currentFile.lastModified}`;
            const chkResp = await fetch('/api/export-video/source/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: srcKey }),
                signal: exportAbort.signal,
            });
            if (!chkResp.ok) throw new Error('source check failed');
            if (!(await chkResp.json()).cached) {
                await _uploadSource(currentFile, srcKey, status);
            }
            _checkAbort();

            const startResp = await fetch('/api/export-video/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fps: fps, width: bw, height: bh,
                    total_frames: totalFrames,
                }),
                signal: exportAbort.signal,
            });
            if (!startResp.ok) throw new Error('start session failed');
            exportId = (await startResp.json()).export_id;

            _checkAbort();
            status.textContent = speeds.length > 1
                ? `Encoding ${speeds.length} speeds in parallel…`
                : 'Encoding…';
            const stampFrame = !!$('stampFrameNumber')?.checked;
            const stampSecs  = !!$('stampTime')?.checked;
            // Poll encode progress while the encode request is in flight.
            const pollTimer = setInterval(async () => {
                try {
                    const r = await fetch(`/api/export-video/${exportId}/status`);
                    if (!r.ok) return;
                    const pct = Math.round(((await r.json()).progress || 0) * 100);
                    if (pct > 0) status.textContent = `Encoding… ${pct}%`;
                } catch (_) {}
            }, 500);
            let encResp;
            try {
                encResp = await fetch(`/api/export-video/${exportId}/encode-direct`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        key: srcKey,
                        start_frame: startFrame,
                        end_frame: endFrame,
                        crop: cropBody,
                        speeds: queue.map(q => ({ speed: q.speed, badge: !!q.badge })),
                        show_frame_num: stampFrame,
                        show_time: stampSecs,
                    }),
                    signal: exportAbort.signal,
                });
            } finally {
                clearInterval(pollTimer);
            }
            if (!encResp.ok) throw new Error('encoding failed');
            const encInfo = await encResp.json();
            const files = encInfo.files || [];
            if (!files.length) throw new Error('encoder produced no files');

            const fileBySpeed = new Map(files.map(f => [f.speed, f.name]));
            for (let i = 0; i < queue.length; i++) {
                _checkAbort();
                const sp = queue[i].speed;
                const name = fileBySpeed.get(sp);
                if (!name) throw new Error(`server didn't return file for ${sp}x`);
                status.textContent = `Saving ${i + 1} / ${queue.length} (${sp}x)…`;
                const dlResp = await fetch(
                    `/api/export-video/${exportId}/file/${encodeURIComponent(name)}`,
                    { signal: exportAbort.signal });
                if (!dlResp.ok) throw new Error(`download failed for ${sp}x`);
                const blob = await dlResp.blob();
                const writable = await saveHandles[i].createWritable();
                await writable.write(blob);
                await writable.close();
                handlesToCleanup[i] = null;
            }
            status.textContent = (queue.length === 1)
                ? `Saved to ${saveHandles[0].name}.`
                : `Saved ${queue.length} files.`;
            fetch(`/api/export-video/${exportId}`, { method: 'DELETE' }).catch(() => {});
            exportId = null;
        } catch (err) {
            if (err && err.name === 'AbortError') {
                status.textContent = 'Cancelled.';
            } else {
                console.error(err);
                status.textContent = 'Error: ' + err.message;
            }
            if (exportId) {
                fetch(`/api/export-video/${exportId}`, { method: 'DELETE' }).catch(() => {});
            }
            for (const h of handlesToCleanup) {
                if (h && typeof h.remove === 'function') {
                    try { await h.remove(); } catch (_) {}
                }
            }
        } finally {
            exportRunning = false;
            exportAbort = null;
            const wasAborted = exportAbortRequested;
            exportAbortRequested = false;
            btn.disabled = false;
            cancelBtn.disabled = false;
            // Restore the queue-config controls if we're still in
            // export mode (cancellation drops us out).
            if (!wasAborted && exportMode) {
                $('addSpeedBtn').style.display = '';
                $('exportFrameStampRow').style.display = '';
            }
            _updateAddSpeedBtn();
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
