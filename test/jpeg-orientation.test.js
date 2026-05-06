import assert from "node:assert/strict";
import test from "node:test";

import {
  isJpegFile,
  readJpegExifOrientation,
  rotateExifOrientationClockwise,
  rotateJpegExifOrientationClockwise,
  setJpegExifOrientation,
} from "../src/jpeg-orientation.js";

const MINIMAL_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);

test("detects JPEG files by MIME type or extension", () => {
  assert.equal(isJpegFile("photo.jpg", ""), true);
  assert.equal(isJpegFile("photo.jpeg", ""), true);
  assert.equal(isJpegFile("photo.bin", "image/jpeg"), true);
  assert.equal(isJpegFile("photo.png", "image/png"), false);
});

test("maps EXIF orientation to the next clockwise orientation", () => {
  assert.equal(rotateExifOrientationClockwise(1), 6);
  assert.equal(rotateExifOrientationClockwise(6), 3);
  assert.equal(rotateExifOrientationClockwise(3), 8);
  assert.equal(rotateExifOrientationClockwise(8), 1);
  assert.equal(rotateExifOrientationClockwise(2), 7);
  assert.equal(rotateExifOrientationClockwise(7), 4);
});

test("inserts EXIF Orientation when JPEG has no EXIF segment", () => {
  const updated = setJpegExifOrientation(MINIMAL_JPEG, 6);

  assert.equal(readJpegExifOrientation(updated), 6);
  assert.equal(updated.length, MINIMAL_JPEG.length + 36);
  assert.equal(updated[0], 0xff);
  assert.equal(updated[1], 0xd8);
  assert.equal(updated[2], 0xff);
  assert.equal(updated[3], 0xe1);
  assert.deepEqual([...updated.slice(38)], [...MINIMAL_JPEG.slice(2)]);
});

test("updates an existing EXIF Orientation in place", () => {
  const withExif = setJpegExifOrientation(MINIMAL_JPEG, 1);
  const rotated = rotateJpegExifOrientationClockwise(withExif);

  assert.equal(rotated.length, withExif.length);
  assert.equal(readJpegExifOrientation(rotated), 6);
});

test("does not add a duplicate EXIF segment when Orientation is missing from existing EXIF", () => {
  const withExif = setJpegExifOrientation(MINIMAL_JPEG, 1);
  const withoutOrientationTag = new Uint8Array(withExif);
  withoutOrientationTag[20] = 0x00;
  withoutOrientationTag[21] = 0x00;

  assert.throws(() => setJpegExifOrientation(withoutOrientationTag, 6), /Orientation tag is missing/);
});

test("throws for non-JPEG data", () => {
  assert.throws(() => setJpegExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 6), /not a JPEG/);
});
