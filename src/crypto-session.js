import { AES_GCM_IV_BYTES, AUTH_NONCE_BYTES, SESSION_SECRET_BYTES, SECURE_PROTOCOL_VERSION } from "./constants.js";
import { base64UrlToBytes, bytesToBase64Url, decodeText, encodeText, toArrayBuffer, toUint8Array } from "./codec.js";

export function isSecureCryptoSupported(cryptoObject = globalThis.crypto) {
  return Boolean(cryptoObject?.getRandomValues && cryptoObject?.subtle && globalThis.TextEncoder && globalThis.TextDecoder);
}

export function createRandomBytes(length, cryptoObject = globalThis.crypto) {
  const bytes = new Uint8Array(length);
  cryptoObject.getRandomValues(bytes);
  return bytes;
}

export function createSessionSecret(cryptoObject = globalThis.crypto) {
  return bytesToBase64Url(createRandomBytes(SESSION_SECRET_BYTES, cryptoObject));
}

export function createAuthNonce(cryptoObject = globalThis.crypto) {
  return bytesToBase64Url(createRandomBytes(AUTH_NONCE_BYTES, cryptoObject));
}

export function isValidSessionSecret(secret) {
  try {
    return base64UrlToBytes(secret).byteLength === SESSION_SECRET_BYTES;
  } catch {
    return false;
  }
}

export async function deriveSessionKeys(sessionSecret, cryptoObject = globalThis.crypto) {
  const secretBytes = base64UrlToBytes(sessionSecret);
  const baseKey = await cryptoObject.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveKey"]);
  const salt = encodeText("qr-transfer-v1");

  const authKey = await cryptoObject.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encodeText("auth"),
    },
    baseKey,
    {
      name: "HMAC",
      hash: "SHA-256",
      length: 256,
    },
    false,
    ["sign", "verify"],
  );

  const encryptionKey = await cryptoObject.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encodeText("file-encryption"),
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );

  return { authKey, encryptionKey };
}

export function createAuthMessage(role, nonce) {
  return `qr-transfer-v${SECURE_PROTOCOL_VERSION}|auth|${role}|${nonce}`;
}

export async function signAuthMessage(sessionKeys, message, cryptoObject = globalThis.crypto) {
  const signature = await cryptoObject.subtle.sign("HMAC", sessionKeys.authKey, encodeText(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyAuthMessage(sessionKeys, message, token, cryptoObject = globalThis.crypto) {
  try {
    return await cryptoObject.subtle.verify(
      "HMAC",
      sessionKeys.authKey,
      base64UrlToBytes(token),
      encodeText(message),
    );
  } catch {
    return false;
  }
}

export async function encryptJsonPayload(sessionKeys, value, additionalData, cryptoObject = globalThis.crypto) {
  return encryptBinaryPayload(sessionKeys, encodeText(JSON.stringify(value)), additionalData, cryptoObject);
}

export async function decryptJsonPayload(sessionKeys, payload, additionalData, cryptoObject = globalThis.crypto) {
  const buffer = await decryptBinaryPayload(sessionKeys, payload, additionalData, cryptoObject);
  return JSON.parse(decodeText(new Uint8Array(buffer)));
}

export async function encryptBinaryPayload(sessionKeys, value, additionalData, cryptoObject = globalThis.crypto) {
  const iv = createRandomBytes(AES_GCM_IV_BYTES, cryptoObject);
  const data = toArrayBuffer(value);
  const ciphertext = await cryptoObject.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encodeText(additionalData),
    },
    sessionKeys.encryptionKey,
    data,
  );

  return {
    iv: iv.buffer,
    data: ciphertext,
  };
}

export async function decryptBinaryPayload(sessionKeys, payload, additionalData, cryptoObject = globalThis.crypto) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Missing encrypted payload");
  }

  const iv = toUint8Array(payload.iv);
  if (iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new Error("Invalid AES-GCM IV length");
  }

  return cryptoObject.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encodeText(additionalData),
    },
    sessionKeys.encryptionKey,
    toArrayBuffer(payload.data),
  );
}
