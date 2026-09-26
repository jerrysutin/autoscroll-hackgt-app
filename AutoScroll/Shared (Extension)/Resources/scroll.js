// Runs before content.js in the extension's isolated content-script world.
// Future reaction detection can call AutoScroll.next() or send AUTOSCROLL_NEXT.
(() => {

    function platform() {
        const host = location.hostname;
        if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && /^\/shorts\/[^/]+/.test(location.pathname)) return 'youtube';
        if ((host === 'instagram.com' || host.endsWith('.instagram.com')) && /^\/reels?(?:\/|$)/.test(location.pathname)) return 'instagram';
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
        // Shorts/Reels preload offscreen videos. Select the one mostly in view.
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

        // Reels commonly live in a nested, vertically snapping scroll container.
        const container = scrollContainer(video);
        if (!container) return { advanced: false, reason: 'no-scroll-container' };
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) return { advanced: false, reason: 'end-of-feed' };
        container.scrollBy({ top: container.clientHeight, behavior: 'smooth' });
        // "advanced" means navigation was requested; the site controls loading.
        return { advanced: true, platform: site, method: 'scroll' };
    }

    globalThis.AutoScroll = Object.freeze({
        next,
        status: () => ({ platform: platform(), hasVisibleShort: Boolean(currentVideo()) })
    });
})();
