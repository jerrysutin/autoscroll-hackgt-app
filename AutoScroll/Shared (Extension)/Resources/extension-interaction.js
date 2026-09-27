// Content script for YouTube (the extension's isolated world).
// - While AutoScroll is on (toolbar popup) and a Short is open, adds a hidden
//   extension frame (engine.html) that runs the models, and captures the
//   microphone and camera here in the page for it. Leaving Shorts or turning AutoScroll
//   off removes the frame and stops the camera and microphone.
// - Receives the frame's decisions (AUTOSCROLL_DECISION) and scrolls on "scroll".
// - Pauses the Short while the camera cannot see you, and resumes it on return.
// - Moves to the next Short when the current one ends.
// - Shows a small pop-up when the frame is ready; saves its status for the popup.
(() => {
    // decide() can run many times a second. After a scroll, ignore further scroll
    // decisions while the next reel loads and the viewer sees it.
    const COOLDOWN_MS = 3000;
    let lastScroll = -Infinity;

    function platform() {
        const host = location.hostname;
        if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && /^\/shorts\/[^/]+/.test(location.pathname)) return 'youtube';
        return null;
    }

    function visibleArea(element) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return 0;
        return Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) *
            Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    }

    function currentVideo() {
        if (document.visibilityState !== 'visible' || !platform()) return null;
        // Shorts preloads offscreen videos. Select the one mostly in view.
        return [...document.querySelectorAll('video')]
            .filter(video => {
                const rect = video.getBoundingClientRect();
                return rect.width >= 100 && rect.height >= 100 &&
                    visibleArea(video) >= rect.width * rect.height * 0.5;
            })
            .sort((a, b) => visibleArea(b) - visibleArea(a))[0] || null;
    }

    function scrollContainer(video) {
        for (let node = video.parentElement; node; node = node.parentElement) {
            if (node === document.body || node === document.documentElement) break;
            if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 2) return node;
        }
        const root = document.scrollingElement;
        return root && root.scrollHeight > root.clientHeight + 2 ? root : null;
    }

    function next() {
        const site = platform();
        if (!site) return { advanced: false, reason: 'unsupported-page' };
        const video = currentVideo();
        if (!video) return { advanced: false, reason: 'no-visible-short' };

        // Prefer YouTube's own navigation control to preserve player behavior.
        if (site === 'youtube') {
            const button = [...document.querySelectorAll(
                '#navigation-button-down button, button[aria-label="Next video"], button[aria-label="Next Short"]'
            )].find(node => visibleArea(node) > 0 && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
            if (button) {
                button.click();
                return { advanced: true, platform: site, method: 'next-button' };
            }
            const current = video.closest('ytd-reel-video-renderer');
            const nextReel = current?.nextElementSibling;
            if (nextReel?.matches('ytd-reel-video-renderer')) {
                nextReel.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return { advanced: true, platform: site, method: 'next-reel' };
            }
        }

        // Otherwise scroll the nested, vertically snapping Shorts container.
        const container = scrollContainer(video);
        if (!container) return { advanced: false, reason: 'no-scroll-container' };
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) return { advanced: false, reason: 'end-of-feed' };
        container.scrollBy({ top: container.clientHeight, behavior: 'smooth' });
        // "advanced" means navigation was requested; the site controls loading.
        return { advanced: true, platform: site, method: 'scroll' };
    }

    // decision: true = scroll, false = watch, null = no reading (see decision.js).
    function applyDecision(decision) {
        if (decision !== true) return { advanced: false, reason: decision === false ? 'watch' : 'no-decision' };
        const wait = lastScroll + COOLDOWN_MS - Date.now();
        if (wait > 0) return { advanced: false, reason: 'cooldown', retryInMs: wait };
        const result = next();
        if (result.advanced) lastScroll = Date.now();
        return result;
    }

    // Small notice in the corner of the page. Built without innerHTML (YouTube
    // enforces Trusted Types); a closed shadow root keeps the site's styles out.
    function showToast(title, detail) {
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = `
            .toast { position: fixed; top: 16px; right: 16px; z-index: 2147483647; max-width: 260px;
                padding: 10px 14px; border-radius: 10px; background: rgba(20, 20, 20, 0.9); color: #fff;
                font: 13px/1.35 -apple-system, system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
                animation: in 0.2s ease-out, out 0.4s ease-in 3.2s forwards; pointer-events: none; }
            strong { display: block; font-size: 14px; }
            @keyframes in { from { opacity: 0; transform: translateY(-6px); } }
            @keyframes out { to { opacity: 0; transform: translateY(-6px); } }`;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.setAttribute('role', 'status');
        const heading = document.createElement('strong');
        heading.textContent = title;
        const text = document.createElement('span');
        text.textContent = detail;
        toast.append(heading, text);
        root.append(style, toast);
        (document.body || document.documentElement).append(host);
        setTimeout(() => host.remove(), 3700);
    }

    // --- The hidden engine frame (engine.html) ---------------------------------
    // Present only while AutoScroll is on (toolbar popup) and a Short is open.
    // Removing it stops the camera; the microphone below stops with it.
    const ENGINE_URL = browser.runtime.getURL('engine.html');
    const FRAME_LOAD_MS = 20000;
    let enabled = false;
    let frame = null;
    let token = '';
    let engineReady = false;
    let frameTimer = null;

    // What this page sees, for the toolbar popup (the frame reports its own part).
    // Refreshed every second while on Shorts, so the popup can tell it is live.
    const page = { frame: 'none', microphone: 'off', camera: 'off' };
    function setPage(changes) {
        Object.assign(page, changes);
        browser.storage.local.set({ page: { ...page, at: Date.now() } }).catch(() => {});
    }

    // Messages sent to the frame and the last send error, for the popup's Link row.
    const link = { sent: 0, error: null, rewritten: false };

    function sendToFrame(message, transfer = []) {
        if (!frame) return;
        // Safari rewrites the extension address of a frame embedded in a web page,
        // so the frame's src cannot be compared with ENGINE_URL. The engine only
        // accepts messages with its token; noted for the popup.
        link.rewritten = frame.getAttribute('src') !== `${ENGINE_URL}#${token}`;
        try {
            frame.contentWindow.postMessage({ ...message, token }, '*', transfer);
            link.sent++;
        } catch (error) {
            link.error = `${error?.name || 'Error'}: ${error?.message || error}`;
            console.warn('AutoScroll could not reach its engine:', error);
        }
    }

    function removeFrame() {
        resumeIfPaused();
        Object.assign(link, { sent: 0, error: null, rewritten: false });
        microphone.stop();
        camera.stop();
        clearTimeout(frameTimer);
        frame.remove();
        frame = null;
        engineReady = false;
        browser.storage.local.set({ status: null }).catch(() => {});
        setPage({ frame: 'none', microphone: 'off', camera: 'off' });
    }

    function updateFrame() {
        const wanted = enabled && Boolean(platform());
        if (frame && (!wanted || !frame.isConnected)) removeFrame();
        if (wanted && !frame) {
            token = crypto.randomUUID();
            frame = document.createElement('iframe');
            frame.src = `${ENGINE_URL}#${token}`;
            frame.title = 'AutoScroll';
            frame.setAttribute('aria-hidden', 'true');
            // Tiny and invisible, but inside the viewport so Safari keeps it running.
            Object.assign(frame.style, {
                position: 'fixed', left: '0', bottom: '0', width: '2px', height: '2px',
                border: '0', opacity: '0', pointerEvents: 'none', zIndex: '-1'
            });
            (document.body || document.documentElement).append(frame);
            setPage({ frame: 'loading' });
            frameTimer = setTimeout(() => {
                if (!engineReady) setPage({ frame: 'did not load' });
            }, FRAME_LOAD_MS);
            // Ask for the microphone, then the camera, right away, whether or not
            // the frame loads. Both are captured here in the page: Safari mutes one
            // capture when another site in the same tab (the frame) starts capturing.
            microphone.start().finally(() => camera.start());
        }
        if (frame) setPage({ link: { ...link } });
    }

    // --- Microphone --------------------------------------------------------------
    // Captured here in the YouTube page, not in the frame: Safari does not let a
    // hidden cross-origin frame start audio without a click inside it. Framed
    // audio (audio-worklet.js, loaded before this script) is streamed to the frame.
    const microphone = {
        context: null, stream: null, node: null, framer: null, starting: false,

        async start() {
            if (this.context || this.starting) return;
            this.starting = true;
            setPage({ microphone: 'asking for permission' });
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: {
                    channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true
                } });
                if (!frame) { stream.getTracks().forEach(track => track.stop()); setPage({ microphone: 'off' }); return; }
                const context = new AudioContext();
                const source = context.createMediaStreamSource(stream);
                // ScriptProcessor needs no module file, which YouTube's page policy would block.
                const node = context.createScriptProcessor(2048, 1, 1);
                node.onaudioprocess = event => {
                    const samples = event.inputBuffer.getChannelData(0);
                    this.framer?.push([samples], samples.length, true);
                };
                source.connect(node);
                node.connect(context.destination); // outputs silence
                Object.assign(this, { context, stream, node });
                const [track] = stream.getAudioTracks();
                track.addEventListener('ended', () => {
                    setPage({ microphone: 'disconnected' });
                    sendToFrame({ type: 'AUTOSCROLL_MIC_ERROR', message: 'Microphone disconnected.' });
                });
                const showState = () => setPage({ microphone: context.state === 'running'
                    ? `on (${track.label || 'microphone'})` : 'waiting: click or press a key on the page' });
                context.onstatechange = showState;
                showState();
                if (context.state !== 'running') this.resumeOnGesture();
                this.sendFormat();
            } catch (error) {
                console.warn('AutoScroll microphone:', error);
                setPage({ microphone: error?.name === 'NotAllowedError'
                    ? 'blocked: allow the microphone for youtube.com'
                    : `error: ${error?.name || ''} ${error?.message || error}`.trim() });
            } finally {
                this.starting = false;
            }
        },

        // If Safari holds audio until the user interacts, start on the next click or key.
        resumeOnGesture() {
            const resume = () => {
                this.context?.resume().catch(() => {});
                if (!this.context || this.context.state === 'running') {
                    document.removeEventListener('pointerdown', resume, true);
                    document.removeEventListener('keydown', resume, true);
                }
            };
            this.context.resume().catch(() => {});
            document.addEventListener('pointerdown', resume, true);
            document.addEventListener('keydown', resume, true);
        },

        // Tell the frame the audio format once both the microphone and the frame are ready.
        // Re-sent on every tick until the engine answers with AUTOSCROLL_MIC_CONFIG.
        sendFormat() {
            if (!this.context || !engineReady || this.framer) return;
            const [track] = this.stream.getAudioTracks();
            sendToFrame({ type: 'AUTOSCROLL_MIC_FORMAT', sampleRate: this.context.sampleRate, label: track?.label || '' });
        },

        configure(options) {
            this.framer = new AutoScrollFramer(options, (packet, transfer) => {
                // Stamped at capture, so the engine can drop audio it gets too late.
                sendToFrame({ type: 'AUTOSCROLL_MIC_PACKET', packet: { ...packet, capturedAt: Date.now() } }, transfer);
            });
        },

        stop() {
            if (this.node) this.node.onaudioprocess = null;
            this.node?.disconnect();
            this.stream?.getTracks().forEach(track => track.stop());
            if (this.context) this.context.onstatechange = null;
            this.context?.close().catch(() => {});
            Object.assign(this, { context: null, stream: null, node: null, framer: null });
        }
    };

    // --- Camera -----------------------------------------------------------------
    // Captured here (see above) into a hidden video; about 6 downscaled frames a
    // second go to the frame as raw pixels for face detection.
    const CAMERA_FRAME_MS = 160;
    // At most one camera frame and one tick wait for the engine at a time, so a
    // busy engine never builds a backlog (each frame is ~300 KB). A reply that
    // never comes is given up on after ACK_TIMEOUT_MS.
    const ACK_TIMEOUT_MS = 2000;
    const CAMERA_WIDTH = 320;
    const camera = {
        stream: null, video: null, timer: null, starting: false,

        async start() {
            if (this.stream || this.starting || !frame) return;
            this.starting = true;
            setPage({ camera: 'asking for permission' });
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
                    facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }
                } });
                if (!frame) { stream.getTracks().forEach(track => track.stop()); setPage({ camera: 'off' }); return; }
                const video = document.createElement('video');
                video.muted = true;
                video.playsInline = true;
                video.setAttribute('aria-hidden', 'true');
                Object.assign(video.style, {
                    position: 'fixed', left: '0', bottom: '0', width: '2px', height: '2px',
                    opacity: '0', pointerEvents: 'none', zIndex: '-1'
                });
                video.srcObject = stream;
                (document.body || document.documentElement).append(video);
                await video.play();
                const canvas = document.createElement('canvas');
                const context2d = canvas.getContext('2d', { willReadFrequently: true });
                this.timer = setInterval(() => this.sendFrame(video, canvas, context2d), CAMERA_FRAME_MS);
                Object.assign(this, { stream, video });
                const [track] = stream.getVideoTracks();
                track.addEventListener('ended', () => setPage({ camera: 'disconnected' }));
                setPage({ camera: `on (${track.label || 'camera'})` });
            } catch (error) {
                console.warn('AutoScroll camera:', error);
                setPage({ camera: error?.name === 'NotAllowedError'
                    ? 'blocked: allow the camera for youtube.com'
                    : `error: ${error?.name || ''} ${error?.message || error}`.trim() });
            } finally {
                this.starting = false;
            }
        },

        async sendFrame(video, canvas, context2d) {
            if (!engineReady || video.readyState < 2 || !video.videoWidth || this.sending) return;
            if (this.frameSentAt && Date.now() - this.frameSentAt < ACK_TIMEOUT_MS) return; // engine still busy
            this.sending = true;
            try {
                canvas.width = CAMERA_WIDTH;
                canvas.height = Math.round(CAMERA_WIDTH * video.videoHeight / video.videoWidth);
                context2d.drawImage(video, 0, 0, canvas.width, canvas.height);
                // Raw pixels: an ArrayBuffer transfers to any frame, unlike an ImageBitmap.
                const { data, width, height } = context2d.getImageData(0, 0, canvas.width, canvas.height);
                sendToFrame({ type: 'AUTOSCROLL_CAMERA_FRAME', width, height, pixels: data.buffer }, [data.buffer]);
                this.frameSentAt = Date.now();
            } catch (error) {
                console.warn('AutoScroll camera frame:', error);
            } finally {
                this.sending = false;
            }
        },

        stop() {
            clearInterval(this.timer);
            this.frameSentAt = 0;
            this.stream?.getTracks().forEach(track => track.stop());
            this.video?.remove();
            Object.assign(this, { stream: null, video: null, timer: null });
        }
    };

    // --- Next Short when this one ends --------------------------------------------
    // Shorts loop, so "ended" rarely fires. Advance when a playing video reaches
    // its last END_MARGIN_S seconds, or wraps from the end back to the start.
    // Once per playthrough; a paused video never advances.
    const END_MARGIN_S = 0.35;
    const ending = { video: null, key: '', lastTime: 0, firedAt: 0 };

    function checkVideoEnd() {
        if (!enabled || !scrollAtEnd) return;
        const video = currentVideo();
        if (!video) return;
        const { currentTime, duration } = video;
        const key = `${video.currentSrc || video.src}|${Math.round(duration || 0)}`;
        if (video !== ending.video || key !== ending.key) {
            Object.assign(ending, { video, key, lastTime: currentTime, firedAt: 0 });
            return;
        }
        const wrapped = currentTime + 1 < ending.lastTime && ending.lastTime > duration - 1.5;
        ending.lastTime = currentTime;
        // After firing, allow again only once a new playthrough is under way (the
        // scroll failed and the video looped), not at the wrap right after it.
        if (ending.firedAt && Date.now() - ending.firedAt > 2000 && currentTime < 1) ending.firedAt = 0;
        if (ending.firedAt || !Number.isFinite(duration) || duration < 1) return;
        if (video.paused && !video.ended) return;
        if (!video.ended && !wrapped && duration - currentTime > END_MARGIN_S) return;
        ending.firedAt = Date.now();
        const result = next();
        if (result.advanced) lastScroll = Date.now(); // reactions wait the usual 3 s
        setPage({ scroll: { advanced: result.advanced, detail: result.advanced ? 'video ended' : result.reason, at: Date.now() } });
    }

    // --- Pause while you are away -------------------------------------------------
    // No face looking at the camera for AWAY_MS (you left, or turned your head)
    // pauses the Short; looking back resumes it. Only a video paused here is
    // resumed, so a pause or play by the user wins.
    const AWAY_MS = 500;
    const away = { video: null, handled: false };

    function resumeIfPaused() {
        const video = away.video;
        away.video = null;
        away.handled = false;
        if (!video) return;
        if (video.paused && video.isConnected) video.play().catch(error => console.warn('AutoScroll could not resume:', error));
        setPage({ paused: false });
    }

    // presence: { known, absentMs } from the engine (see getFacePresence()).
    function handlePresence(presence) {
        if (!pauseWhenAway || !presence?.known || presence.absentMs < AWAY_MS) {
            resumeIfPaused();
            return;
        }
        // Once per absence: a play by the user while away is not undone.
        if (away.handled) return;
        const video = currentVideo();
        if (!video) return; // try again on the next report
        away.handled = true;
        if (video.paused) return; // already paused by the user
        video.pause();
        away.video = video;
        setPage({ paused: true });
        showToast('Paused', "AutoScroll can't see you. The Short resumes when you're back.");
    }

    // Messages from the frame carry its token. (The page could read the token, but
    // it can scroll itself anyway; the frame never trusts the page's messages.)
    let lastStatus = null;
    window.addEventListener('message', event => {
        const request = event.data;
        if (!frame || !token || request?.token !== token) return;
        if (request.type === 'AUTOSCROLL_ENGINE_READY') {
            engineReady = true;
            setPage({ frame: 'loaded' });
            microphone.sendFormat();
        }
        if (request.type === 'AUTOSCROLL_MIC_CONFIG') microphone.configure(request.options);
        if (request.type === 'AUTOSCROLL_MIC_STOP') {
            // The engine's audio analysis stopped (e.g. after an error). Keep the
            // microphone on; the format is re-sent each tick, which restarts it.
            microphone.framer = null;
        }
        if (request.type === 'AUTOSCROLL_PRESENCE') {
            tickSentAt = 0; // the engine handled the last tick
            handlePresence(request.presence);
        }
        if (request.type === 'AUTOSCROLL_FRAME_DONE') camera.frameSentAt = 0;
        if (request.type === 'AUTOSCROLL_DECISION') {
            const result = applyDecision(request.decision);
            // Record every scroll attempt for the popup (not "watch", which is constant).
            if (request.decision === true) {
                setPage({ scroll: { advanced: result.advanced, detail: result.advanced ? result.method : result.reason, at: Date.now() } });
            }
        }
        if (request.type === 'AUTOSCROLL_READY') {
            showToast('AutoScroll is on', 'Scrolling automatically based on your reactions.');
        }
        if (request.type === 'AUTOSCROLL_STATUS') {
            lastStatus = request.status;
            browser.storage.local.set({ status: { ...lastStatus, at: Date.now() } }).catch(() => {});
        }
    });

    // On/off comes from the toolbar popup.
    // Face sensitivity also comes from the popup; it goes to the engine with each tick.
    // "Pause when you look away" is on by default.
    let faceSensitivity = 'medium';
    let pauseWhenAway = true;
    let scrollAtEnd = true;
    browser.storage.local.get(['enabled', 'faceSensitivity', 'pauseWhenAway', 'scrollAtEnd']).then(stored => {
        enabled = stored?.enabled !== false; // on by default
        faceSensitivity = stored?.faceSensitivity || faceSensitivity;
        pauseWhenAway = stored?.pauseWhenAway !== false;
        scrollAtEnd = stored?.scrollAtEnd !== false;
    }).catch(error => {
        console.warn('AutoScroll could not read its setting; staying on.', error);
        enabled = true;
    }).finally(updateFrame);
    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.faceSensitivity) faceSensitivity = changes.faceSensitivity.newValue || 'medium';
        if (changes.scrollAtEnd) scrollAtEnd = changes.scrollAtEnd.newValue !== false;
        if (changes.pauseWhenAway) {
            pauseWhenAway = changes.pauseWhenAway.newValue !== false;
            if (!pauseWhenAway) resumeIfPaused();
        }
        if (!changes.enabled) return;
        enabled = changes.enabled.newValue !== false;
        updateFrame();
    });

    // Manual skip: Option/Alt + Shift + ArrowDown. Ignore text editing and repeats.
    document.addEventListener('keydown', event => {
        const target = event.target;
        if (event.repeat || event.defaultPrevented || event.isComposing ||
            target?.isContentEditable || target?.closest?.('input, textarea, select, [role="textbox"]')) return;
        if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'ArrowDown') {
            if (next().advanced) event.preventDefault();
        }
    });

    // YouTube changes pages without reloading, so check every second.
    setInterval(updateFrame, 1000);
    updateFrame();
    setInterval(checkVideoEnd, 200);

    // Drive the engine's decisions from this visible page: Safari may throttle
    // timers inside a hidden frame from another site.
    let tickSentAt = 0;
    setInterval(() => {
        if (!engineReady) return;
        microphone.sendFormat();
        if (tickSentAt && Date.now() - tickSentAt < ACK_TIMEOUT_MS) return; // engine still busy
        sendToFrame({ type: 'AUTOSCROLL_TICK', faceSensitivity });
        tickSentAt = Date.now();
    }, 250);

    globalThis.AutoScroll = Object.freeze({
        next,
        applyDecision,
        status: () => ({ platform: platform(), hasVisibleShort: Boolean(currentVideo()) })
    });
})();
