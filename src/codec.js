export function encodeText(text) {
  return new TextEncoder().encode(text);
}

export function decodeText(bytes) {
  return new TextDecoder().decode(bytes);
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoaPortable(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error("Invalid base64url text");
  }

  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atobPortable(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  throw new Error("Expected binary data");
}

export function toArrayBuffer(value) {
  const bytes = toUint8Array(value);
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }

  return bytes.slice().buffer;
}

function btoaPortable(binary) {
  if (typeof globalThis.btoa === "function") return globalThis.btoa(binary);
  return Buffer.from(binary, "binary").toString("base64");
}

function atobPortable(base64) {
  if (typeof globalThis.atob === "function") return globalThis.atob(base64);
  return Buffer.from(base64, "base64").toString("binary");
}
