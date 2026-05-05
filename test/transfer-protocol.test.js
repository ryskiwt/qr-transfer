import assert from "node:assert/strict";
import test from "node:test";

import { TRANSFER_CHUNK_SIZE } from "../src/constants.js";
import {
  canSendFile,
  createFileChunkAad,
  createFileMetaAad,
  isValidChunkEnvelope,
  normalizeFileMeta,
} from "../src/transfer-protocol.js";

test("normalizeFileMeta accepts well-formed metadata", () => {
  const id = "transfer-1";
  const meta = {
    id,
    name: "photo.jpg",
    mime: "image/jpeg",
    size: TRANSFER_CHUNK_SIZE + 10,
    totalChunks: 2,
  };

  assert.deepEqual(normalizeFileMeta(meta, id), meta);
});

test("normalizeFileMeta rejects mismatched chunk counts", () => {
  assert.throws(
    () => normalizeFileMeta({ id: "x", name: "x.txt", mime: "text/plain", size: TRANSFER_CHUNK_SIZE + 1, totalChunks: 1 }, "x"),
    /Invalid file metadata/,
  );
});

test("isValidChunkEnvelope validates final chunk length", () => {
  const meta = { size: TRANSFER_CHUNK_SIZE + 10, totalChunks: 2 };

  assert.equal(isValidChunkEnvelope({ index: 0, byteLength: TRANSFER_CHUNK_SIZE }, meta), true);
  assert.equal(isValidChunkEnvelope({ index: 1, byteLength: 10 }, meta), true);
  assert.equal(isValidChunkEnvelope({ index: 1, byteLength: 11 }, meta), false);
});

test("canSendFile rejects empty names and invalid chunk counts", () => {
  assert.equal(canSendFile({ name: "a.txt", type: "text/plain", size: 1 }, 1), true);
  assert.equal(canSendFile({ name: "", type: "text/plain", size: 1 }, 1), false);
  assert.equal(canSendFile({ name: "a.txt", type: "text/plain", size: 1 }, 0), false);
});

test("AAD strings include the protocol namespace", () => {
  assert.equal(createFileMetaAad("x"), "qr-transfer-v1|file-meta|x");
  assert.equal(createFileChunkAad("x", 2, 3), "qr-transfer-v1|file-chunk|x|2|3");
});
