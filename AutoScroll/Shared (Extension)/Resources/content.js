// Bridge extension messages to the scrolling module.
browser.runtime.onMessage.addListener(request => {
    if (request?.type === 'AUTOSCROLL_NEXT') return Promise.resolve(AutoScroll.next());
    if (request?.type === 'AUTOSCROLL_STATUS') return Promise.resolve(AutoScroll.status());
});

// Manual testing: Option/Alt + Shift + ArrowDown. Ignore text editing and repeats.
document.addEventListener('keydown', event => {
    const target = event.target;
    if (event.repeat || event.defaultPrevented || event.isComposing ||
        target?.isContentEditable || target?.closest?.('input, textarea, select, [role="textbox"]')) return;
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'ArrowDown') {
        const result = AutoScroll.next();
        if (result.advanced) event.preventDefault();
    }
});
