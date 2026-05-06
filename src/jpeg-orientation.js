const JPEG_SOI = 0xffd8;
const JPEG_SOS_MARKER = 0xda;
const JPEG_EOI_MARKER = 0xd9;
const JPEG_APP1_MARKER = 0xe1;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const TIFF_BIG_ENDIAN = [0x4d, 0x4d];
const TIFF_LITTLE_ENDIAN = [0x49, 0x49];
const EXIF_ORIENTATION_TAG = 0x0112;
const TIFF_SHORT_TYPE = 3;
const DEFAULT_ORIENTATION = 1;

const CLOCKWISE_ORIENTATION = {
  1: 6,
  2: 7,
  3: 8,
  4: 5,
  5: 2,
  6: 3,
  7: 4,
  8: 1,
};

export function isJpegFile(name = "", mime = "") {
  return /^image\/jpe?g$/i.test(mime) || /\.jpe?g$/i.test(name);
}

export function rotateExifOrientationClockwise(orientation = DEFAULT_ORIENTATION) {
  return CLOCKWISE_ORIENTATION[orientation] || CLOCKWISE_ORIENTATION[DEFAULT_ORIENTATION];
}

export function readJpegExifOrientation(input) {
  const bytes = toUint8Array(input);
  const orientation = findJpegExifOrientation(bytes);
  if (!orientation) return DEFAULT_ORIENTATION;

  return readUint16(bytes, orientation.valueOffset, orientation.littleEndian);
}

export function setJpegExifOrientation(input, orientation) {
  const bytes = toMutableUint8Array(input);
  const nextOrientation = normalizeOrientation(orientation);

  if (!isJpegBytes(bytes)) {
    throw new Error("Input is not a JPEG file");
  }

  const current = findJpegExifOrientation(bytes);
  if (current) {
    writeUint16(bytes, current.valueOffset, nextOrientation, current.littleEndian);
    return bytes;
  }

  if (hasJpegExifSegment(bytes)) {
    throw new Error("JPEG EXIF Orientation tag is missing");
  }

  return insertExifOrientationSegment(bytes, nextOrientation);
}

export function rotateJpegExifOrientationClockwise(input) {
  const currentOrientation = readJpegExifOrientation(input);
  return setJpegExifOrientation(input, rotateExifOrientationClockwise(currentOrientation));
}

export async function createJpegWithRotatedExifOrientation(blob) {
  const bytes = rotateJpegExifOrientationClockwise(await blob.arrayBuffer());
  return new Blob([bytes], { type: blob.type || "image/jpeg" });
}

function normalizeOrientation(orientation) {
  return Number.isInteger(orientation) && orientation >= 1 && orientation <= 8 ? orientation : DEFAULT_ORIENTATION;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  throw new TypeError("Expected ArrayBuffer or Uint8Array");
}

function toMutableUint8Array(input) {
  const bytes = toUint8Array(input);
  return new Uint8Array(bytes);
}

function isJpegBytes(bytes) {
  return bytes.length >= 2 && readUint16BigEndian(bytes, 0) === JPEG_SOI;
}

function findJpegExifOrientation(bytes) {
  for (const segment of findJpegExifSegments(bytes)) {
    const orientation = findExifOrientationInTiff(bytes, segment.payloadOffset + EXIF_HEADER.length, segment.segmentEnd);
    if (orientation) return orientation;
  }

  return null;
}

function hasJpegExifSegment(bytes) {
  return findJpegExifSegments(bytes).length > 0;
}

function findJpegExifSegments(bytes) {
  const segments = [];
  if (!isJpegBytes(bytes)) return segments;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return segments;

    const marker = bytes[offset + 1];
    if (marker === JPEG_SOS_MARKER || marker === JPEG_EOI_MARKER) return segments;

    const segmentLength = readUint16BigEndian(bytes, offset + 2);
    if (segmentLength < 2) return segments;

    const segmentEnd = offset + 2 + segmentLength;
    if (segmentEnd > bytes.length) return segments;

    const payloadOffset = offset + 4;
    if (marker === JPEG_APP1_MARKER && startsWith(bytes, payloadOffset, EXIF_HEADER)) {
      segments.push({ payloadOffset, segmentEnd });
    }

    offset = segmentEnd;
  }

  return segments;
}

function findExifOrientationInTiff(bytes, tiffOffset, exifEnd) {
  if (tiffOffset + 8 > exifEnd) return null;

  const littleEndian = isTiffLittleEndian(bytes, tiffOffset);
  if (littleEndian === null) return null;
  if (readUint16(bytes, tiffOffset + 2, littleEndian) !== 42) return null;

  const firstIfdOffset = readUint32(bytes, tiffOffset + 4, littleEndian);
  const ifdOffset = tiffOffset + firstIfdOffset;
  if (ifdOffset + 2 > exifEnd) return null;

  const entryCount = readUint16(bytes, ifdOffset, littleEndian);
  const entriesOffset = ifdOffset + 2;
  const entriesEnd = entriesOffset + entryCount * 12;
  if (entriesEnd + 4 > exifEnd) return null;

  for (let entryOffset = entriesOffset; entryOffset < entriesEnd; entryOffset += 12) {
    const tag = readUint16(bytes, entryOffset, littleEndian);
    if (tag !== EXIF_ORIENTATION_TAG) continue;

    const type = readUint16(bytes, entryOffset + 2, littleEndian);
    const count = readUint32(bytes, entryOffset + 4, littleEndian);
    if (type !== TIFF_SHORT_TYPE || count < 1) return null;

    if (count <= 2) {
      return { valueOffset: entryOffset + 8, littleEndian };
    }

    const valueOffset = tiffOffset + readUint32(bytes, entryOffset + 8, littleEndian);
    if (valueOffset + 2 > exifEnd) return null;
    return { valueOffset, littleEndian };
  }

  return null;
}

function isTiffLittleEndian(bytes, offset) {
  if (matches(bytes, offset, TIFF_LITTLE_ENDIAN)) return true;
  if (matches(bytes, offset, TIFF_BIG_ENDIAN)) return false;
  return null;
}

function insertExifOrientationSegment(bytes, orientation) {
  const segment = createExifOrientationSegment(orientation);
  const nextBytes = new Uint8Array(bytes.length + segment.length);

  nextBytes.set(bytes.subarray(0, 2), 0);
  nextBytes.set(segment, 2);
  nextBytes.set(bytes.subarray(2), 2 + segment.length);

  return nextBytes;
}

function createExifOrientationSegment(orientation) {
  const payload = new Uint8Array(32);
  payload.set(EXIF_HEADER, 0);
  payload.set(TIFF_BIG_ENDIAN, 6);
  writeUint16BigEndian(payload, 8, 42);
  writeUint32BigEndian(payload, 10, 8);
  writeUint16BigEndian(payload, 14, 1);
  writeUint16BigEndian(payload, 16, EXIF_ORIENTATION_TAG);
  writeUint16BigEndian(payload, 18, TIFF_SHORT_TYPE);
  writeUint32BigEndian(payload, 20, 1);
  writeUint16BigEndian(payload, 24, orientation);

  const segment = new Uint8Array(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = JPEG_APP1_MARKER;
  writeUint16BigEndian(segment, 2, payload.length + 2);
  segment.set(payload, 4);

  return segment;
}

function startsWith(bytes, offset, expected) {
  return offset + expected.length <= bytes.length && expected.every((byte, index) => bytes[offset + index] === byte);
}

function matches(bytes, offset, expected) {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function readUint16(bytes, offset, littleEndian) {
  return littleEndian ? bytes[offset] | (bytes[offset + 1] << 8) : readUint16BigEndian(bytes, offset);
}

function writeUint16(bytes, offset, value, littleEndian) {
  if (littleEndian) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    return;
  }

  writeUint16BigEndian(bytes, offset, value);
}

function readUint16BigEndian(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function writeUint16BigEndian(bytes, offset, value) {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function readUint32(bytes, offset, littleEndian) {
  if (littleEndian) {
    return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000 + bytes[offset + 3] * 0x1000000;
  }

  return readUint32BigEndian(bytes, offset);
}

function readUint32BigEndian(bytes, offset) {
  return (bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
}

function writeUint32BigEndian(bytes, offset, value) {
  bytes[offset] = (value >> 24) & 0xff;
  bytes[offset + 1] = (value >> 16) & 0xff;
  bytes[offset + 2] = (value >> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
