import assert from "node:assert/strict";
import test from "node:test";
import { PASSPORT_RATIO, rotatedPhotoSize, passportCropRect, panPassportCrop, drawPassportCrop } from "../src/passportCrop.js";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < .000001, `${actual} != ${expected}`);

test("landscape photos are centered in a 35:45 portrait frame", () => {
  const crop = passportCropRect(1800, 1200);
  close(crop.height, 1200);
  close(crop.width, 1200 * 7 / 9);
  close(crop.x + crop.width / 2, 900);
  close(crop.y, 0);
});

test("tall portraits preserve the image center and crop excess height", () => {
  const crop = passportCropRect(800, 1600);
  close(crop.width, 800);
  close(crop.y + crop.height / 2, 800);
  close(crop.width / crop.height, PASSPORT_RATIO);
});

test("crop and zoom stay within source bounds at every edge and rotation", () => {
  for (const [width, height] of [[4000, 1000], [900, 4500], [1200, 1200], [700, 900]]) {
    for (const rotation of [0, 90, 180, 270]) {
      const size = rotatedPhotoSize(width, height, rotation);
      for (const zoom of [0, 1, 1.25, 2, 4, 8]) {
        for (const x of [-5, -1, 0, 1, 5]) for (const y of [-5, -1, 0, 1, 5]) {
          const crop = passportCropRect(size.width, size.height, { zoom, position: { x, y } });
          assert.ok(crop.x >= -.000001 && crop.y >= -.000001);
          assert.ok(crop.x + crop.width <= size.width + .000001);
          assert.ok(crop.y + crop.height <= size.height + .000001);
          close(crop.width / crop.height, PASSPORT_RATIO);
        }
      }
    }
  }
});

test("dragging moves the photo with the pointer and clamps at its edges", () => {
  const settings = { zoom: 2, position: { x: 0, y: 0 }, rotation: 0 };
  const next = panPassportCrop(1800, 1200, settings, 20, 20, 252, 324);
  assert.ok(next.x < 0 && next.y < 0);
  const edge = panPassportCrop(1800, 1200, settings, -100000, 100000, 252, 324);
  assert.deepEqual(edge, { x: 1, y: -1 });
  const fullWidth = panPassportCrop(700, 900, { ...settings, zoom: 1 }, 30, 30, 252, 324);
  assert.deepEqual(fullWidth, { x: 0, y: 0 });
});

test("zoom increases detail without changing the center or passport ratio", () => {
  const base = passportCropRect(4000, 3000);
  const zoomed = passportCropRect(4000, 3000, { zoom: 3 });
  close(zoomed.width * 3, base.width);
  close(zoomed.height * 3, base.height);
  close(zoomed.x + zoomed.width / 2, 2000);
  close(zoomed.y + zoomed.height / 2, 1500);
});

test("export uses a 700 by 900 canvas and the expected orientation after rotation", () => {
  for (const rotation of [0, 90, 180, 270]) {
    let matrix, drew = false;
    const ctx = {
      fillRect() {},
      setTransform(...values) { matrix = values; },
      translate(x, y) { matrix[4] += matrix[0] * x + matrix[2] * y; matrix[5] += matrix[1] * x + matrix[3] * y; },
      rotate(angle) {
        const [a, b, c, d] = matrix, cos = Math.cos(angle), sin = Math.sin(angle);
        matrix[0] = a * cos + c * sin; matrix[1] = b * cos + d * sin;
        matrix[2] = c * cos - a * sin; matrix[3] = d * cos - b * sin;
      },
      drawImage() { drew = true; },
    };
    const canvas = { getContext: () => ctx };
    drawPassportCrop(canvas, { naturalWidth: 1800, naturalHeight: 1200 }, { rotation, zoom: 1, position: { x: 0, y: 0 } });
    assert.deepEqual([canvas.width, canvas.height], [700, 900]);
    assert.ok(drew);
    const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
    const center = point(900, 600), right = point(910, 600);
    close(center[0], 350); close(center[1], 450);
    if (rotation === 0) assert.ok(right[0] > center[0]);
    if (rotation === 90) assert.ok(right[1] > center[1]);
    if (rotation === 180) assert.ok(right[0] < center[0]);
    if (rotation === 270) assert.ok(right[1] < center[1]);
  }
});

test("invalid photos and unavailable canvas contexts fail with clear errors", () => {
  assert.throws(() => passportCropRect(0, 100), /invalid dimensions/);
  assert.throws(() => passportCropRect(Infinity, 100), /invalid dimensions/);
  assert.throws(() => drawPassportCrop({ getContext: () => null }, { naturalWidth: 700, naturalHeight: 900 }, {}), /could not prepare/);
});
