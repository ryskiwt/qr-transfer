const TRANSFER_CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const TEXT_PREVIEW_LIMIT = 1024 * 1024;
const DESKTOP_PEER_STORAGE_KEY = "qr-transfer-desktop-peer-id";
const PHONE_RECONNECT_BASE_DELAY = 700;
const PHONE_RECONNECT_MAX_DELAY = 5000;
const JPEG_THUMBNAIL_READ_BYTES = 512 * 1024;
const EMBEDDED_THUMBNAIL_SCAN_BYTES = 2 * 1024 * 1024;
const EMBEDDED_THUMBNAIL_MAX_BYTES = 512 * 1024;

const els = {
  viewTitle: document.querySelector("#view-title"),
  pill: document.querySelector("#connection-pill"),
  desktopView: document.querySelector("#desktop-view"),
  phoneView: document.querySelector("#phone-view"),
  unsupportedView: document.querySelector("#unsupported-view"),
  qrCode: document.querySelector("#qr-code"),
  qrLoading: document.querySelector("#qr-loading"),
  phoneLink: document.querySelector("#phone-link"),
  desktopStatus: document.querySelector("#desktop-status"),
  phoneStatus: document.querySelector("#phone-status-text"),
  sendProgress: document.querySelector("#send-progress"),
  transferList: document.querySelector("#transfer-list"),
  previewName: document.querySelector("#preview-name"),
  previewDetail: document.querySelector("#preview-detail"),
  previewContent: document.querySelector("#preview-content"),
  pickFile: document.querySelector("#pick-file"),
  openCamera: document.querySelector("#open-camera"),
  fileInput: document.querySelector("#file-input"),
  cameraInput: document.querySelector("#camera-input"),
  fileReviewPanel: document.querySelector("#file-review-panel"),
  fileReviewName: document.querySelector("#file-review-name"),
  fileReviewDetail: document.querySelector("#file-review-detail"),
  fileReviewContent: document.querySelector("#file-review-content"),
  chooseAnotherFile: document.querySelector("#choose-another-file"),
  sendSelectedFile: document.querySelector("#send-selected-file"),
};

const state = {
  peer: null,
  conn: null,
  targetPeerId: null,
  pendingFile: null,
  pendingSource: null,
  pendingFileUrl: null,
  incomingTransfers: new Map(),
  objectUrls: new Set(),
  isSending: false,
  isClosing: false,
  desktopRetryTimer: null,
  phoneReconnectTimer: null,
  phoneReconnectAttempts: 0,
};

window.addEventListener("DOMContentLoaded", init);
window.addEventListener("beforeunload", cleanup);

function init() {
  if (!window.Peer || !window.RTCPeerConnection) {
    showUnsupported();
    return;
  }

  bindEvents();

  const params = new URLSearchParams(window.location.search);
  const targetPeerId = params.get("peer");

  if (targetPeerId) {
    startPhone(targetPeerId);
  } else {
    startDesktop();
  }
}

function bindEvents() {
  els.pickFile.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", handleFilePicked);
  els.cameraInput.addEventListener("change", handleCameraPicked);
  els.chooseAnotherFile.addEventListener("click", chooseAnotherFile);
  els.sendSelectedFile.addEventListener("click", sendSelectedFile);
  els.openCamera.addEventListener("click", openCamera);
}

function showUnsupported() {
  els.viewTitle.textContent = "WebRTCを利用できません";
  setPill("非対応", "error");
  els.desktopView.hidden = true;
  els.phoneView.hidden = true;
  els.unsupportedView.hidden = false;
}

function startDesktop() {
  els.viewTitle.textContent = "WebRTCでファイルを受信";
  setPill("接続準備中");
  els.desktopView.hidden = false;
  els.phoneView.hidden = true;
  els.unsupportedView.hidden = true;

  const peerId = getDesktopPeerId();
  ensureDesktopUrlHasRoom(peerId);
  createDesktopPeer(peerId);
}

function createDesktopPeer(peerId, retryCount = 0) {
  window.clearTimeout(state.desktopRetryTimer);

  if (state.peer && !state.peer.destroyed) {
    state.peer.destroy();
  }

  const peer = createPeer(peerId);
  state.peer = peer;

  peer.on("open", (id) => {
    setPill("待機中", "warn");
    els.desktopStatus.textContent = "スマートフォンからの送信を待っています";

    const phoneUrl = buildPhoneUrl(id);
    els.phoneLink.href = phoneUrl;
    els.phoneLink.textContent = phoneUrl;
    renderQr(phoneUrl);
  });

  peer.on("connection", (conn) => {
    state.conn = conn;
    attachReceiver(conn);
  });

  peer.on("error", (error) => {
    if (error?.type === "unavailable-id" && !state.isClosing) {
      const delay = Math.min(800 + retryCount * 350, 3500);
      setPill("再接続準備中", "warn");
      els.desktopStatus.textContent =
        "前の接続を閉じています。スマートフォンからの送信を待てる状態へ戻しています";
      state.desktopRetryTimer = window.setTimeout(() => createDesktopPeer(peerId, retryCount + 1), delay);
      return;
    }

    setPill("接続エラー", "error");
    els.desktopStatus.textContent = formatPeerError(error);
  });
}

function startPhone(targetPeerId) {
  els.viewTitle.textContent = "WebRTCでファイルを送信";
  setPill("接続中", "warn");
  els.desktopView.hidden = true;
  els.phoneView.hidden = false;
  els.unsupportedView.hidden = true;
  setPhoneReady(false);
  state.targetPeerId = targetPeerId;

  const peer = createPeer();
  state.peer = peer;

  peer.on("open", () => {
    connectToDesktop();
  });

  peer.on("error", (error) => {
    if (state.isClosing) return;

    setPhoneReady(false);
    els.phoneStatus.textContent = formatPeerError(error);

    if (error?.type === "peer-unavailable" || error?.type === "network" || error?.type === "socket-closed") {
      schedulePhoneReconnect();
      return;
    }

    setPill("接続エラー", "error");
  });
}

function connectToDesktop() {
  if (!state.peer?.open || !state.targetPeerId || state.isClosing) return;

  window.clearTimeout(state.phoneReconnectTimer);
  state.phoneReconnectTimer = null;

  if (state.conn?.open) return;

  setPill("接続中", "warn");
  setPhoneReady(false);
  els.phoneStatus.textContent = "PCへ接続しています";

  const conn = state.peer.connect(state.targetPeerId, {
    reliable: true,
    metadata: { role: "phone" },
  });
  state.conn = conn;
  attachSender(conn);
}

function createPeer(id) {
  return new Peer(id);
}

function schedulePhoneReconnect() {
  if (state.isClosing || state.phoneReconnectTimer) return;

  const delay = Math.min(
    PHONE_RECONNECT_BASE_DELAY + state.phoneReconnectAttempts * 600,
    PHONE_RECONNECT_MAX_DELAY,
  );

  state.phoneReconnectAttempts += 1;
  setPill("再接続中", "warn");
  setPhoneReady(false);
  els.phoneStatus.textContent = "PCへ再接続しています";
  state.phoneReconnectTimer = window.setTimeout(() => {
    state.phoneReconnectTimer = null;
    connectToDesktop();
  }, delay);
}

function buildPhoneUrl(peerId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("peer", peerId);
  return url.toString();
}

function getDesktopPeerId() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("room");

  if (roomId) {
    writeStoredPeerId(roomId);
    return roomId;
  }

  const storedId = readStoredPeerId();
  if (storedId) return storedId;

  const nextId = createPeerId();
  writeStoredPeerId(nextId);
  return nextId;
}

function ensureDesktopUrlHasRoom(peerId) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("room") === peerId) return;

  url.search = "";
  url.hash = "";
  url.searchParams.set("room", peerId);
  window.history.replaceState(null, "", url);
}

function readStoredPeerId() {
  try {
    return window.localStorage.getItem(DESKTOP_PEER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredPeerId(peerId) {
  try {
    window.localStorage.setItem(DESKTOP_PEER_STORAGE_KEY, peerId);
  } catch {
    // localStorageが使えない場合も、URLのroomパラメータで同じIDを維持する。
  }
}

function createPeerId() {
  const bytes = new Uint8Array(12);

  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return `qr-transfer-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function renderQr(url) {
  if (!window.QRCode) {
    els.qrLoading.textContent = "QRコードを生成できません。下のリンクをスマートフォンで開いてください。";
    return;
  }

  els.qrCode.replaceChildren();
  new QRCode(els.qrCode, {
    text: url,
    width: 256,
    height: 256,
    colorDark: "#111827",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel?.M ?? 0,
  });
  els.qrLoading.hidden = true;
}

function attachReceiver(conn) {
  setPill("接続済み", "success");
  els.desktopStatus.textContent = "スマートフォンからの送信を待っています";

  conn.on("open", () => {
    setPill("接続済み", "success");
  });

  conn.on("data", handleIncomingData);

  conn.on("close", () => {
    setPill("切断", "warn");
    els.desktopStatus.textContent = "スマートフォンからの再接続を待っています";
  });

  conn.on("error", () => {
    setPill("受信エラー", "error");
    els.desktopStatus.textContent = "受信中にエラーが発生しました。接続をやり直してください。";
  });
}

function attachSender(conn) {
  conn.on("open", () => {
    if (state.conn !== conn) return;

    state.phoneReconnectAttempts = 0;
    setPill("接続済み", "success");
    setPhoneReady(true);
    els.phoneStatus.textContent = "送信するファイルを選択してください";
  });

  conn.on("close", () => {
    if (state.conn !== conn || state.isClosing) return;

    setPill("再接続中", "warn");
    setPhoneReady(false);
    els.phoneStatus.textContent = "PCへ再接続しています";
    schedulePhoneReconnect();
  });

  conn.on("error", () => {
    if (state.conn !== conn || state.isClosing) return;

    setPill("再接続中", "warn");
    setPhoneReady(false);
    els.phoneStatus.textContent = "PCへ再接続しています";
    schedulePhoneReconnect();
  });
}

function handleIncomingData(data) {
  if (!data || typeof data !== "object") return;

  if (data.type === "file-meta") {
    state.incomingTransfers.set(data.id, {
      meta: data,
      chunks: new Array(data.totalChunks),
      receivedBytes: 0,
      receivedChunks: 0,
      element: createReceivingItem(data),
    });
    els.desktopStatus.textContent = `${data.name} を受信しています`;
    return;
  }

  if (data.type === "file-chunk") {
    const transfer = state.incomingTransfers.get(data.id);
    if (!transfer || transfer.chunks[data.index]) return;

    transfer.chunks[data.index] = data.chunk;
    transfer.receivedChunks += 1;
    transfer.receivedBytes += data.byteLength;
    updateReceivingItem(transfer);

    if (transfer.receivedChunks === transfer.meta.totalChunks) {
      completeReceivingItem(data.id, transfer);
    }
  }
}

function createReceivingItem(meta) {
  removeEmptyState();

  const item = document.createElement("article");
  item.className = "transfer-item";

  const thumb = document.createElement("div");
  thumb.className = "transfer-thumb";
  thumb.textContent = fileInitial(meta.name);

  const detail = document.createElement("div");
  detail.className = "transfer-meta";

  const name = document.createElement("p");
  name.className = "transfer-name";
  name.textContent = meta.name;

  const status = document.createElement("p");
  status.className = "transfer-detail";
  status.textContent = `0% / ${formatBytes(meta.size)}`;

  const progress = document.createElement("progress");
  progress.max = 100;
  progress.value = 0;

  detail.append(name, status, progress);
  item.append(thumb, detail);
  els.transferList.prepend(item);

  return { item, thumb, status, progress };
}

function updateReceivingItem(transfer) {
  const percent =
    transfer.meta.size === 0 ? 100 : Math.floor((transfer.receivedBytes / transfer.meta.size) * 100);
  transfer.element.progress.value = percent;
  transfer.element.status.textContent = `${percent}% / ${formatBytes(transfer.meta.size)}`;
}

function completeReceivingItem(id, transfer) {
  const blob = new Blob(transfer.chunks, {
    type: transfer.meta.mime || "application/octet-stream",
  });
  const url = createObjectUrl(blob);

  transfer.element.progress.remove();
  transfer.element.status.textContent = `${formatBytes(blob.size)} を受信しました`;

  if (blob.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "transfer-thumb";
    img.src = url;
    img.alt = `${transfer.meta.name} のプレビュー`;
    transfer.element.thumb.replaceWith(img);
    transfer.element.thumb = img;
  }

  const download = document.createElement("a");
  download.className = "download-button";
  download.href = url;
  download.download = transfer.meta.name;
  download.append(createDownloadIcon(), document.createTextNode("ローカルに保存"));
  download.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const actions = document.createElement("div");
  actions.className = "transfer-actions";
  actions.append(download);
  transfer.element.item.append(actions);
  transfer.element.item.classList.add("is-complete");
  transfer.element.item.tabIndex = 0;
  transfer.element.item.setAttribute("role", "button");
  transfer.element.item.setAttribute("aria-label", `${transfer.meta.name} をプレビュー`);

  const openPreview = () => {
    selectTransferItem(transfer.element.item);
    void showReceivedPreview({ blob, meta: transfer.meta, url });
  };
  transfer.element.item.addEventListener("click", openPreview);
  transfer.element.item.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    openPreview();
  });

  state.incomingTransfers.delete(id);
  setPill("受信完了", "success");
  els.desktopStatus.textContent = "受信が完了しました。スマートフォンからの次の送信を待っています";
  openPreview();
}

async function showReceivedPreview({ blob, meta, url }) {
  els.previewName.textContent = meta.name;
  els.previewDetail.textContent = `${formatBytes(blob.size)} / ${meta.mime || "application/octet-stream"}`;
  await renderFilePreview(els.previewContent, { blob, meta, url });
}

async function renderFilePreview(container, { blob, meta, url }) {
  container.replaceChildren();
  container.dataset.previewKind = "empty";
  const mime = blob.type || meta.mime || "";

  if (isTextPreviewable(meta.name, mime, blob.size)) {
    container.dataset.previewKind = "text";
    const pre = document.createElement("pre");
    pre.className = "preview-text";
    pre.textContent = await blob.text();
    container.append(pre);
    return;
  }

  if (mime.startsWith("image/")) {
    container.dataset.previewKind = "image";
    const image = document.createElement("img");
    image.src = url;
    image.alt = `${meta.name} のプレビュー`;
    container.append(image);
    return;
  }

  if (mime.startsWith("video/")) {
    container.dataset.previewKind = "video";
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    container.append(video);
    return;
  }

  if (mime.startsWith("audio/")) {
    container.dataset.previewKind = "audio";
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    container.append(audio);
    return;
  }

  if (mime === "application/pdf") {
    container.dataset.previewKind = "pdf";
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = `${meta.name} のプレビュー`;
    container.append(frame);
    return;
  }

  const empty = document.createElement("p");
  empty.className = "preview-empty";
  empty.textContent = "このファイル形式はブラウザ内プレビューに対応していません。";
  container.append(empty);
}

async function handleFilePicked(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;

  await showSelectedFilePreview(file, "file");
}

async function handleCameraPicked(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;

  setPhoneReady(false);
  els.phoneStatus.textContent = "撮影した写真を確認しています";

  const [thumbnail, diagnostics] = await Promise.all([
    extractEmbeddedThumbnail(file).catch(() => null),
    readImageDiagnostics(file).catch(() => null),
  ]);

  await showSelectedFilePreview(file, "camera", {
    diagnostics,
    previewBlob: thumbnail,
    skipImagePreview: !thumbnail,
    previewMessage: thumbnail ? null : "撮影した写真を選択しました。",
  });
  els.phoneStatus.textContent = thumbnail
    ? "撮影した写真のサムネイルを表示しています"
    : "撮影した写真を選択しました。プレビューを省略しています";
}

async function showSelectedFilePreview(file, source, options = {}) {
  clearPendingFile();

  const previewBlob = options.previewBlob || null;
  const url = previewBlob ? createObjectUrl(previewBlob) : options.skipImagePreview ? null : createObjectUrl(file);
  state.pendingFile = file;
  state.pendingSource = source;
  state.pendingFileUrl = url;

  els.fileReviewPanel.hidden = false;
  els.fileReviewName.textContent = file.name;
  els.fileReviewDetail.textContent = formatSelectedFileDetail(file, options.diagnostics);
  els.chooseAnotherFile.textContent = source === "camera" ? "撮り直す" : "選び直す";
  if (url) {
    await renderFilePreview(els.fileReviewContent, {
      blob: previewBlob || file,
      meta: {
        name: file.name,
        mime: previewBlob?.type || file.type,
      },
      url,
    });
  } else {
    renderPreviewMessage(els.fileReviewContent, options.previewMessage || "撮影した写真を選択しました。");
  }
  if (source !== "camera") {
    els.phoneStatus.textContent = "送信するファイルを確認してください";
  }
  setPhoneReady(Boolean(state.conn?.open));
}

async function readImageDiagnostics(file) {
  if (!isJpegFile(file)) return null;

  const dimensions = await readJpegDimensions(file);
  return {
    ...dimensions,
    decodedBytes: dimensions.width * dimensions.height * 4,
  };
}

async function readJpegDimensions(file) {
  const buffer = await file.slice(0, Math.min(file.size, JPEG_THUMBNAIL_READ_BYTES)).arrayBuffer();
  const view = new DataView(buffer);

  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) {
    throw new Error("Unsupported JPEG");
  }

  let offset = 2;
  while (offset + 9 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;

    const marker = view.getUint8(offset + 1);
    if (marker === 0xda || marker === 0xd9) break;

    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > view.byteLength) break;

    if (isJpegStartOfFrame(marker)) {
      return {
        width: view.getUint16(offset + 7),
        height: view.getUint16(offset + 5),
      };
    }

    offset += 2 + length;
  }

  throw new Error("JPEG dimensions not found");
}

async function extractEmbeddedThumbnail(file) {
  return (await extractJpegExifThumbnail(file)) || (await extractEmbeddedJpegPreview(file));
}

async function extractJpegExifThumbnail(file) {
  const buffer = await file.slice(0, Math.min(file.size, JPEG_THUMBNAIL_READ_BYTES)).arrayBuffer();
  const view = new DataView(buffer);

  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;

    const marker = view.getUint8(offset + 1);
    if (marker === 0xda || marker === 0xd9) return null;

    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > view.byteLength) return null;

    const segmentStart = offset + 4;
    const segmentLength = length - 2;
    if (marker === 0xe1 && readAscii(view, segmentStart, 6) === "Exif\0\0") {
      return readExifThumbnail(view, segmentStart + 6, segmentLength - 6);
    }

    offset += 2 + length;
  }

  return null;
}

function readExifThumbnail(view, tiffStart, length) {
  if (length < 14 || tiffStart + length > view.byteLength) return null;

  const byteOrder = readAscii(view, tiffStart, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return null;

  const getUint16 = (offset) => view.getUint16(offset, littleEndian);
  const getUint32 = (offset) => view.getUint32(offset, littleEndian);
  if (getUint16(tiffStart + 2) !== 42) return null;

  const ifd0Offset = getUint32(tiffStart + 4);
  const ifd1Offset = readNextIfdOffset(view, tiffStart, tiffStart + length, ifd0Offset, getUint16, getUint32);
  if (!ifd1Offset) return null;

  const entries = readIfdEntries(view, tiffStart, tiffStart + length, ifd1Offset, getUint16, getUint32);
  const thumbnailOffset = entries.get(0x0201);
  const thumbnailLength = entries.get(0x0202);
  if (!thumbnailOffset || !thumbnailLength || thumbnailLength > EMBEDDED_THUMBNAIL_MAX_BYTES) return null;

  const start = tiffStart + thumbnailOffset;
  const end = start + thumbnailLength;
  if (start < tiffStart || end > tiffStart + length || view.getUint16(start) !== 0xffd8) return null;

  return new Blob([view.buffer.slice(start, end)], { type: "image/jpeg" });
}

function readNextIfdOffset(view, tiffStart, tiffEnd, ifdOffset, getUint16, getUint32) {
  const entryCountOffset = tiffStart + ifdOffset;
  if (entryCountOffset + 2 > tiffEnd) return 0;

  const entryCount = getUint16(entryCountOffset);
  const nextOffsetPosition = entryCountOffset + 2 + entryCount * 12;
  if (nextOffsetPosition + 4 > tiffEnd) return 0;

  return getUint32(nextOffsetPosition);
}

function readIfdEntries(view, tiffStart, tiffEnd, ifdOffset, getUint16, getUint32) {
  const entries = new Map();
  const entryCountOffset = tiffStart + ifdOffset;
  if (entryCountOffset + 2 > tiffEnd) return entries;

  const entryCount = getUint16(entryCountOffset);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entryCountOffset + 2 + index * 12;
    if (entryOffset + 12 > tiffEnd) break;
    entries.set(getUint16(entryOffset), getUint32(entryOffset + 8));
  }

  return entries;
}

async function extractEmbeddedJpegPreview(file) {
  if (file.type === "image/jpeg") return null;

  const buffer = await file.slice(0, Math.min(file.size, EMBEDDED_THUMBNAIL_SCAN_BYTES)).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return null;

  for (let start = 0; start + 4 < bytes.length; start += 1) {
    if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8 || bytes[start + 2] !== 0xff) continue;

    const endLimit = Math.min(bytes.length - 1, start + EMBEDDED_THUMBNAIL_MAX_BYTES);
    for (let end = start + 4; end < endLimit; end += 1) {
      if (bytes[end] === 0xff && bytes[end + 1] === 0xd9) {
        return new Blob([buffer.slice(start, end + 2)], { type: "image/jpeg" });
      }
    }
  }

  return null;
}

function isJpegFile(file) {
  return file.type === "image/jpeg" || /\.(jpe?g)$/i.test(file.name);
}

function isJpegStartOfFrame(marker) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readAscii(view, start, length) {
  if (start + length > view.byteLength) return "";

  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(view.getUint8(start + index));
  }
  return text;
}

function formatSelectedFileDetail(file, diagnostics) {
  const parts = [formatBytes(file.size), file.type || "application/octet-stream"];

  if (diagnostics?.width && diagnostics?.height) {
    parts.push(`${diagnostics.width} x ${diagnostics.height}px`);
    parts.push(`展開目安 ${formatBytes(diagnostics.decodedBytes)}`);
  }

  return parts.join(" / ");
}

function renderPreviewMessage(container, message) {
  container.replaceChildren();
  container.dataset.previewKind = "empty";

  const empty = document.createElement("p");
  empty.className = "preview-empty";
  empty.textContent = message;
  container.append(empty);
}

function chooseAnotherFile() {
  const source = state.pendingSource;
  clearPendingFile();
  if (source === "camera") {
    els.cameraInput.click();
    return;
  }

  els.fileInput.click();
}

async function sendSelectedFile() {
  if (!state.pendingFile) return;

  const didSend = await sendFile(state.pendingFile);
  if (didSend) {
    clearPendingFile();
  }
}

function clearPendingFile() {
  state.pendingFile = null;
  state.pendingSource = null;

  if (state.pendingFileUrl) {
    revokeObjectUrl(state.pendingFileUrl);
    state.pendingFileUrl = null;
  }

  els.fileReviewPanel.hidden = true;
  els.fileReviewName.textContent = "送信するファイル";
  els.fileReviewDetail.textContent = "";
  els.chooseAnotherFile.textContent = "選び直す";
  els.fileReviewContent.replaceChildren();
  els.fileReviewContent.dataset.previewKind = "empty";
  setPhoneReady(Boolean(state.conn?.open));
}

function openCamera() {
  clearPendingFile();
  els.cameraInput.click();
}

async function sendFile(file) {
  const conn = state.conn;
  if (!conn?.open || state.isSending) return false;

  state.isSending = true;
  setPhoneReady(false);
  setPill("送信中", "warn");
  els.sendProgress.hidden = false;
  els.sendProgress.value = 0;
  els.phoneStatus.textContent = `${file.name} を送信しています`;

  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const totalChunks = Math.max(1, Math.ceil(file.size / TRANSFER_CHUNK_SIZE));

  conn.send({
    type: "file-meta",
    id,
    name: file.name,
    mime: file.type,
    size: file.size,
    totalChunks,
  });

  let didSend = false;

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      await waitForBuffer(conn);
      if (!conn.open) throw new Error("Data connection closed");

      const start = index * TRANSFER_CHUNK_SIZE;
      const end = Math.min(file.size, start + TRANSFER_CHUNK_SIZE);
      const chunk = await file.slice(start, end).arrayBuffer();

      conn.send({
        type: "file-chunk",
        id,
        index,
        byteLength: chunk.byteLength,
        chunk,
      });

      els.sendProgress.value = Math.floor(((index + 1) / totalChunks) * 100);
    }

    setPill("送信完了", "success");
    els.phoneStatus.textContent = "送信が完了しました。続けて別のファイルも送信できます";
    didSend = true;
  } catch {
    setPill("送信エラー", "error");
    els.phoneStatus.textContent = "送信中にエラーが発生しました。接続を確認してやり直してください。";
  } finally {
    state.isSending = false;
    setPhoneReady(Boolean(state.conn?.open));
    els.sendProgress.hidden = true;
  }

  return didSend;
}

function waitForBuffer(conn) {
  return new Promise((resolve) => {
    const check = () => {
      if (!conn.open) {
        resolve();
        return;
      }

      const bufferedAmount =
        typeof conn.bufferSize === "number" ? conn.bufferSize : conn.dataChannel?.bufferedAmount || 0;
      if (bufferedAmount < MAX_BUFFERED_BYTES) {
        resolve();
        return;
      }

      window.setTimeout(check, 40);
    };

    check();
  });
}

function cleanup() {
  state.isClosing = true;
  window.clearTimeout(state.desktopRetryTimer);
  window.clearTimeout(state.phoneReconnectTimer);
  for (const url of [...state.objectUrls]) {
    revokeObjectUrl(url);
  }
  state.conn?.close?.();
  state.peer?.destroy?.();
}

function setPhoneReady(isReady) {
  els.pickFile.disabled = !isReady;
  els.openCamera.disabled = !isReady;
  els.chooseAnotherFile.disabled = state.isSending;
  els.sendSelectedFile.disabled = !isReady || !state.pendingFile;
}

function setPill(text, tone) {
  els.pill.textContent = text;
  if (tone) {
    els.pill.dataset.tone = tone;
  } else {
    delete els.pill.dataset.tone;
  }
}

function removeEmptyState() {
  const empty = els.transferList.querySelector(".empty-state");
  empty?.remove();
}

function createObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.objectUrls.add(url);
  return url;
}

function revokeObjectUrl(url) {
  URL.revokeObjectURL(url);
  state.objectUrls.delete(url);
}

function selectTransferItem(selectedItem) {
  for (const item of els.transferList.querySelectorAll(".transfer-item.is-selected")) {
    item.classList.remove("is-selected");
  }
  selectedItem.classList.add("is-selected");
}

function createDownloadIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  const paths = [
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "M7 10l5 5 5-5",
    "M12 15V3",
  ];

  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }

  return svg;
}

function fileInitial(fileName) {
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? extension.slice(0, 4).toUpperCase() : "FILE";
}

function isTextPreviewable(fileName, mime, size) {
  if (size > TEXT_PREVIEW_LIMIT) return false;
  if (mime.startsWith("text/")) return true;

  const extension = fileName.split(".").pop()?.toLowerCase();
  return ["csv", "json", "md", "txt", "html", "css", "js", "ts", "xml", "svg"].includes(extension);
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;

  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatPeerError(error) {
  if (!error?.type) {
    return "接続中にエラーが発生しました。ページを再読み込みしてやり直してください。";
  }

  const messages = {
    "browser-incompatible": "このブラウザはWebRTCに対応していません。",
    network: "PeerJSのシグナリングサーバーに接続できません。ネットワークを確認してください。",
    "peer-unavailable": "PCの接続IDが見つかりません。QRコードを読み取り直してください。",
    "server-error": "PeerJSのシグナリングサーバーでエラーが発生しました。時間をおいて再試行してください。",
    "socket-error": "PeerJSサーバーとの接続でエラーが発生しました。",
    "socket-closed": "PeerJSサーバーとの接続が閉じられました。",
    webrtc: "WebRTC接続でエラーが発生しました。同じネットワークまたは別のブラウザで試してください。",
  };

  return messages[error.type] || `接続エラーが発生しました: ${error.type}`;
}
