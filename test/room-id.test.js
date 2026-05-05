import assert from "node:assert/strict";
import test from "node:test";

import { formatRoomIdLabel, getRoomIdFromPeerId } from "../src/room-id.js";

test("getRoomIdFromPeerId removes the qr-transfer prefix", () => {
  assert.equal(getRoomIdFromPeerId("qr-transfer-abcdef123456"), "abcdef123456");
  assert.equal(getRoomIdFromPeerId("custom-room"), "custom-room");
});

test("formatRoomIdLabel keeps the full Room ID when it fits", () => {
  const roomId = "abcdef1234567890abcdef12";

  assert.equal(formatRoomIdLabel(roomId, () => true), `Room ID: ${roomId}`);
});

test("formatRoomIdLabel shortens the middle only when needed", () => {
  const roomId = "abcdef1234567890abcdef12";

  const label = formatRoomIdLabel(roomId, (candidate) => candidate.length <= 24);

  assert.equal(label, "Room ID: abcdef...cdef12");
});

test("formatRoomIdLabel falls back to a compact label for narrow widths", () => {
  const roomId = "abcdef1234567890abcdef12";

  assert.equal(formatRoomIdLabel(roomId, () => false), "Room ID: abcd...ef12");
});
