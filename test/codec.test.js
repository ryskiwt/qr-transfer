import assert from "node:assert/strict";
import test from "node:test";

import { base64UrlToBytes, bytesToBase64Url, toArrayBuffer, toUint8Array } from "../src/codec.js";

test("base64url round trips arbitrary bytes without padding", () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const encoded = bytesToBase64Url(bytes);

  assert.equal(encoded.includes("="), false);
  assert.deepEqual(base64UrlToBytes(encoded), bytes);
});

test("base64url rejects invalid characters", () => {
  assert.throws(() => base64UrlToBytes("abc+"), /Invalid base64url/);
});

test("toArrayBuffer preserves only the view slice", () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const sliced = source.subarray(1, 3);

  assert.deepEqual(new Uint8Array(toArrayBuffer(sliced)), new Uint8Array([2, 3]));
});

test("toUint8Array accepts ArrayBuffer and typed array views", () => {
  const buffer = new Uint8Array([7, 8, 9]).buffer;

  assert.deepEqual(toUint8Array(buffer), new Uint8Array([7, 8, 9]));
  assert.deepEqual(toUint8Array(new DataView(buffer, 1, 2)), new Uint8Array([8, 9]));
});
