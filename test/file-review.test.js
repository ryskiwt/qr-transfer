import assert from "node:assert/strict";
import test from "node:test";

import { getSelectedFilePreviewSkipMessage } from "../src/file-review.js";

const formatBytes = (bytes) => `${bytes} B`;

test("file picker selections always skip sender-side preview", () => {
  const file = { size: 123456 };

  assert.equal(
    getSelectedFilePreviewSkipMessage(file, "file", formatBytes),
    "送信側プレビューは省略します。123456 B",
  );
});

test("app camera captures keep preview enabled", () => {
  assert.equal(getSelectedFilePreviewSkipMessage({ size: 10 }, "app-camera", formatBytes), "");
});
