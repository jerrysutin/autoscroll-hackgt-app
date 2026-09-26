const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources/scroll.js'), 'utf8');

function setup({ host = 'www.youtube.com', pathname = '/shorts/example', hidden = false, videos = true, button = true } = {}) {
    const actions = [];
    const container = {
        parentElement: null, scrollHeight: 2400, clientHeight: 800, scrollTop: 0,
        scrollBy: options => actions.push(['scroll', options.top])
    };
    const video = {
        parentElement: container,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 700, width: 400, height: 700 }),
        closest: () => null
    };
    const nextButton = {
        ...video, disabled: false, getAttribute: () => null,
        click: () => actions.push(['click'])
    };
    const context = {
        location: { hostname: host, pathname },
        innerWidth: 1200, innerHeight: 800,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto' }),
        document: {
            visibilityState: hidden ? 'hidden' : 'visible',
            querySelectorAll: selector => selector === 'video' ? (videos ? [video] : []) : (button ? [nextButton] : []),
            scrollingElement: null
        }
    };
    vm.runInNewContext(source, context);
    return { api: context.AutoScroll, actions, container, video, context };
}

test('only navigates Shorts/Reels routes, including after SPA navigation', () => {
    const env = setup({ pathname: '/watch' });
    assert.equal(env.api.next().reason, 'unsupported-page');
    env.context.location.pathname = '/shorts/new';
    assert.equal(env.api.next().advanced, true);
});

test('requires a visible video and foreground document', () => {
    assert.equal(setup({ hidden: true }).api.next().reason, 'no-visible-short');
    assert.equal(setup({ videos: false }).api.next().reason, 'no-visible-short');
    const env = setup();
    env.video.getBoundingClientRect = () => ({ left: 0, top: 900, right: 400, bottom: 1600, width: 400, height: 700 });
    assert.equal(env.api.next().reason, 'no-visible-short');
    assert.equal(env.actions.length, 0);
});

test('uses YouTube navigation on consecutive calls', () => {
    const env = setup();
    assert.equal(env.api.next().method, 'next-button');
    assert.equal(env.api.next().advanced, true);
    assert.equal(env.actions.length, 2);
});

test('scrolls the Instagram reel container by one viewport', () => {
    const env = setup({ host: 'www.instagram.com', pathname: '/reels/example/' });
    assert.equal(env.api.next().method, 'scroll');
    assert.deepEqual(env.actions, [['scroll', 800]]);
});

test('does not scroll at the end of the feed or without a scroll container', () => {
    const env = setup({ button: false });
    env.container.scrollTop = 1600;
    assert.equal(env.api.next().reason, 'end-of-feed');
    env.container.scrollHeight = 800;
    assert.equal(env.api.next().reason, 'no-scroll-container');
    assert.equal(env.actions.length, 0);
});

test('falls back to the next YouTube renderer when the button is absent', () => {
    const env = setup({ button: false });
    env.video.closest = () => ({ nextElementSibling: {
        matches: () => true,
        scrollIntoView: () => env.actions.push(['next-reel'])
    } });
    assert.equal(env.api.next().method, 'next-reel');
    assert.deepEqual(env.actions, [['next-reel']]);
});
