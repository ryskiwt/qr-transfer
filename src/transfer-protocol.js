import {
  MAX_FILE_NAME_LENGTH,
  MAX_MIME_LENGTH,
  MAX_TRANSFER_CHUNKS,
  SECURE_PROTOCOL_VERSION,
  TRANSFER_CHUNK_SIZE,
} from "./constants.js";

export function canSendFile(file, totalChunks) {
  return (
    typeof file.name === "string" &&
    file.name.length >= 1 &&
    file.name.length <= MAX_FILE_NAME_LENGTH &&
    typeof file.type === "string" &&
    file.type.length <= MAX_MIME_LENGTH &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    Number.isSafeInteger(totalChunks) &&
    totalChunks >= 1 &&
    totalChunks <= MAX_TRANSFER_CHUNKS
  );
}

export function normalizeFileMeta(meta, id) {
  if (!meta || typeof meta !== "object") {
    throw new Error("Invalid file metadata");
  }

  const totalChunks = meta.totalChunks;
  const size = meta.size;
  const expectedTotalChunks = Math.max(1, Math.ceil(size / TRANSFER_CHUNK_SIZE));
  if (
    meta.id !== id ||
    typeof meta.name !== "string" ||
    meta.name.length < 1 ||
    meta.name.length > MAX_FILE_NAME_LENGTH ||
    typeof meta.mime !== "string" ||
    meta.mime.length > MAX_MIME_LENGTH ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isSafeInteger(totalChunks) ||
    totalChunks < 1 ||
    totalChunks > MAX_TRANSFER_CHUNKS ||
    totalChunks !== expectedTotalChunks
  ) {
    throw new Error("Invalid file metadata");
  }

  return {
    id,
    name: meta.name,
    mime: meta.mime,
    size,
    totalChunks,
  };
}

export function isValidChunkEnvelope(data, meta) {
  if (
    !Number.isSafeInteger(data.index) ||
    data.index < 0 ||
    data.index >= meta.totalChunks ||
    !Number.isSafeInteger(data.byteLength) ||
    data.byteLength < 0 ||
    data.byteLength > TRANSFER_CHUNK_SIZE
  ) {
    return false;
  }

  const expectedLength =
    data.index === meta.totalChunks - 1 ? meta.size - data.index * TRANSFER_CHUNK_SIZE : TRANSFER_CHUNK_SIZE;
  return data.byteLength === expectedLength;
}

export function createFileMetaAad(id) {
  return `qr-transfer-v${SECURE_PROTOCOL_VERSION}|file-meta|${id}`;
}

export function createFileChunkAad(id, index, byteLength) {
  return `qr-transfer-v${SECURE_PROTOCOL_VERSION}|file-chunk|${id}|${index}|${byteLength}`;
}
