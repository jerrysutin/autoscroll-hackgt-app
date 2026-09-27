const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../AutoScroll/Shared (Extension)/Resources/face-preprocess.js'), 'utf8');
const prep = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('widens the tight face box to a square with margin, kept inside the frame', async () => {
    const { squareCrop } = await prep;
    assert.deepEqual(squareCrop({ x: 100, y: 50, width: 80, height: 100 }, 320, 240, 1.2), { x: 80, y: 40, width: 120, height: 120 });
    const corner = squareCrop({ x: 0, y: 0, width: 80, height: 80 }, 320, 240, 1.2);
    assert.deepEqual(corner, { x: 0, y: 0, width: 96, height: 96 }, 'shifted, not cut, at the edge');
    const huge = squareCrop({ x: 10, y: 10, width: 300, height: 230 }, 320, 240, 1.2);
    assert.equal(huge.width, 240, 'never larger than the frame');
    assert.ok(huge.x >= 0 && huge.x + huge.width <= 320);
});

test('turns an RGBA crop into the model input: RGB planes, ImageNet-normalized', async () => {
    const { toModelInput, FACE_PREP } = await prep;
    assert.equal(FACE_PREP.size, 224);
    assert.equal(FACE_PREP.margin, 1.2);
    // 2x2 crop: white, black, red, green.
    const rgba = [255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255];
    const input = toModelInput(rgba, 2);
    assert.equal(input.length, 12, '3 planes of 4 pixels');
    const close = (a, b) => Math.abs(a - b) < 1e-4;
    assert.ok(close(input[0], (1 - 0.485) / 0.229), 'white, red plane');
    assert.ok(close(input[1], (0 - 0.485) / 0.229), 'black, red plane');
    assert.ok(close(input[4 + 3], (1 - 0.456) / 0.224), 'green pixel, green plane');
    assert.ok(close(input[8 + 2], (0 - 0.406) / 0.225), 'red pixel, blue plane');
});

test('head turn is small facing the camera and large when turned', async () => {
    const { headTurn, LOOK_AWAY_TURN } = await prep;
    const facing = [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.5, y: 0.5 }];
    const turned = [{ x: 0.45, y: 0.4 }, { x: 0.55, y: 0.4 }, { x: 0.58, y: 0.5 }];
    assert.equal(headTurn(facing, 320, 240), 0);
    assert.ok(headTurn(turned, 320, 240) > LOOK_AWAY_TURN);
    assert.equal(headTurn([], 320, 240), 0, 'no keypoints: treated as facing');
    assert.equal(LOOK_AWAY_TURN, 0.25);
});
