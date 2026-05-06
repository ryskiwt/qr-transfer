import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_SECRET_BYTES } from "../src/constants.js";
import { base64UrlToBytes } from "../src/codec.js";
import {
  createAuthMessage,
  createAuthNonce,
  createSessionSecret,
  decryptBinaryPayload,
  decryptJsonPayload,
  deriveSessionKeys,
  encryptBinaryPayload,
  encryptJsonPayload,
  isSecureCryptoSupported,
  isValidSessionSecret,
  signAuthMessage,
  verifyAuthMessage,
} from "../src/crypto-session.js";

test("session secrets and auth nonces are valid base64url values", () => {
  const secret = createSessionSecret();
  const nonce = createAuthNonce();

  assert.equal(isValidSessionSecret(secret), true);
  assert.equal(base64UrlToBytes(secret).byteLength, SESSION_SECRET_BYTES);
  assert.match(nonce, /^[A-Za-z0-9_-]+$/);
});

test("HMAC auth signs and verifies protocol messages", async () => {
  assert.equal(isSecureCryptoSupported(), true);

  const keys = await deriveSessionKeys(createSessionSecret());
  const message = createAuthMessage("sender", createAuthNonce());
  const token = await signAuthMessage(keys, message);

  assert.equal(await verifyAuthMessage(keys, message, token), true);
  assert.equal(await verifyAuthMessage(keys, `${message}:tampered`, token), false);
});

test("AES-GCM JSON payloads round trip and reject wrong AAD", async () => {
  const keys = await deriveSessionKeys(createSessionSecret());
  const payload = await encryptJsonPayload(keys, { id: "x", size: 123 }, "aad:json");

  assert.deepEqual(await decryptJsonPayload(keys, payload, "aad:json"), { id: "x", size: 123 });
  await assert.rejects(() => decryptJsonPayload(keys, payload, "aad:wrong"));
});

test("AES-GCM binary payloads preserve bytes", async () => {
  const keys = await deriveSessionKeys(createSessionSecret());
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const payload = await encryptBinaryPayload(keys, bytes, "aad:binary");

  assert.deepEqual(new Uint8Array(await decryptBinaryPayload(keys, payload, "aad:binary")), bytes);
});
