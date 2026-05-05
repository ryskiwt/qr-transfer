const TRANSFER_CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const TEXT_PREVIEW_LIMIT = 1024 * 1024;
const DESKTOP_PEER_STORAGE_KEY = "qr-transfer-desktop-peer-id";
const PHONE_RECONNECT_BASE_DELAY = 700;
const PHONE_RECONNECT_MAX_DELAY = 5000;
const CAMERA_JPEG_QUALITY = 0.98;
const CAMERA_VIDEO_CONSTRAINTS = {
  facingMode: { ideal: "environment" },
  width: { ideal: 4096 },
  height: { ideal: 3072 },
  resizeMode: { ideal: "none" },
};

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
  fileReviewPanel: document.querySelector("#file-review-panel"),
  fileReviewName: document.querySelector("#file-review-name"),
  fileReviewDetail: document.querySelector("#file-review-detail"),
  fileReviewContent: document.querySelector("#file-review-content"),
  chooseAnotherFile: document.querySelector("#choose-another-file"),
  sendSelectedFile: document.querySelector("#send-selected-file"),
  cameraPanel: document.querySelector("#camera-panel"),
  cameraPreview: document.querySelector("#camera-preview"),
  captureCanvas: document.querySelector("#capture-canvas"),
  capturedPreview: document.querySelector("#captured-preview"),
  capturePhoto: document.querySelector("#capture-photo"),
  reviewControls: document.querySelector("#review-controls"),
  retakePhoto: document.querySelector("#retake-photo"),
  sendPhoto: document.querySelector("#send-photo"),
};

const state = {
  peer: null,
  conn: null,
  targetPeerId: null,
  cameraStream: null,
  pendingFile: null,
  pendingFileUrl: null,
  capturedBlob: null,
  capturedPreviewUrl: null,
  incomingTransfers: new Map(),
  objectUrls: new Set(),
  isSending: false,
  isClosing: false,
  desktopRetryTimer: null,
  phoneReconnectTimer: null,
  phoneReconnectAttempts: 0,
  isCapturing: false,
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
  els.chooseAnotherFile.addEventListener("click", chooseAnotherFile);
  els.sendSelectedFile.addEventListener("click", sendSelectedFile);
  els.openCamera.addEventListener("click", openCamera);
  els.capturePhoto.addEventListener("click", capturePhoto);
  els.retakePhoto.addEventListener("click", resetCapture);
  els.sendPhoto.addEventListener("click", sendCapturedPhoto);
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
  const mime = blob.type || meta.mime || "";

  if (isTextPreviewable(meta.name, mime, blob.size)) {
    const pre = document.createElement("pre");
    pre.className = "preview-text";
    pre.textContent = await blob.text();
    container.append(pre);
    return;
  }

  if (mime.startsWith("image/")) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = `${meta.name} のプレビュー`;
    container.append(image);
    return;
  }

  if (mime.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    container.append(video);
    return;
  }

  if (mime.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    container.append(audio);
    return;
  }

  if (mime === "application/pdf") {
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

  await showSelectedFilePreview(file);
}

async function showSelectedFilePreview(file) {
  resetCapture();
  closeCamera();
  clearPendingFile();

  const url = createObjectUrl(file);
  state.pendingFile = file;
  state.pendingFileUrl = url;

  els.fileReviewPanel.hidden = false;
  els.fileReviewName.textContent = file.name;
  els.fileReviewDetail.textContent = `${formatBytes(file.size)} / ${file.type || "application/octet-stream"}`;
  await renderFilePreview(els.fileReviewContent, {
    blob: file,
    meta: {
      name: file.name,
      mime: file.type,
    },
    url,
  });
  setPhoneReady(Boolean(state.conn?.open));
}

function chooseAnotherFile() {
  clearPendingFile();
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

  if (state.pendingFileUrl) {
    revokeObjectUrl(state.pendingFileUrl);
    state.pendingFileUrl = null;
  }

  els.fileReviewPanel.hidden = true;
  els.fileReviewName.textContent = "送信するファイル";
  els.fileReviewDetail.textContent = "";
  els.fileReviewContent.replaceChildren();
  setPhoneReady(Boolean(state.conn?.open));
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.phoneStatus.textContent = "このブラウザではカメラを利用できません。";
    return;
  }

  clearPendingFile();
  closeCamera();
  resetCapture();
  els.cameraPanel.hidden = false;

  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: CAMERA_VIDEO_CONSTRAINTS,
      audio: false,
    });
    els.cameraPreview.srcObject = state.cameraStream;
    els.cameraPreview.hidden = false;
    els.phoneStatus.textContent = "撮影してください";
  } catch {
    els.cameraPanel.hidden = true;
    els.phoneStatus.textContent = "カメラを開始できませんでした。ブラウザの権限設定を確認してください。";
  }
}

async function capturePhoto() {
  if (state.isCapturing) return;

  state.isCapturing = true;
  setPhoneReady(false);
  els.phoneStatus.textContent = "写真を作成しています";

  try {
    const photoBlob = await takeHighResolutionPhoto().catch(() => null);
    if (photoBlob) {
      showCapturedPhoto(photoBlob);
      return;
    }

    // ImageCaptureに失敗した場合は、表示中の映像フレームを高品質JPEGとして保存する。
    const frameBlob = await captureVideoFrame();
    if (frameBlob) {
      showCapturedPhoto(frameBlob);
      return;
    }

    els.phoneStatus.textContent = "写真を作成できませんでした。もう一度撮影してください。";
  } finally {
    state.isCapturing = false;
    setPhoneReady(Boolean(state.conn?.open));
  }
}

async function takeHighResolutionPhoto() {
  const [track] = state.cameraStream?.getVideoTracks?.() || [];
  if (!track || !window.ImageCapture) return null;

  const imageCapture = new ImageCapture(track);
  const capabilities = await imageCapture.getPhotoCapabilities?.().catch(() => null);
  const photoSettings = {};

  if (capabilities?.imageWidth?.max) {
    photoSettings.imageWidth = capabilities.imageWidth.max;
  }

  if (capabilities?.imageHeight?.max) {
    photoSettings.imageHeight = capabilities.imageHeight.max;
  }

  const blob = await imageCapture.takePhoto(photoSettings);
  return blob?.size ? blob : null;
}

function captureVideoFrame() {
  const video = els.cameraPreview;
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) {
    els.phoneStatus.textContent = "カメラ映像の準備中です。少し待ってから撮影してください。";
    return Promise.resolve(null);
  }

  const canvas = els.captureCanvas;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", CAMERA_JPEG_QUALITY);
  });
}

function showCapturedPhoto(blob) {
  state.capturedBlob = blob;

  if (state.capturedPreviewUrl) {
    revokeObjectUrl(state.capturedPreviewUrl);
  }

  const previewUrl = createObjectUrl(blob);
  state.capturedPreviewUrl = previewUrl;
  els.capturedPreview.src = previewUrl;
  els.capturedPreview.hidden = false;
  els.cameraPreview.hidden = true;
  els.capturePhoto.hidden = true;
  els.reviewControls.hidden = false;
  els.phoneStatus.textContent = "この写真を送信しますか？";
}

function resetCapture() {
  state.capturedBlob = null;
  if (state.capturedPreviewUrl) {
    revokeObjectUrl(state.capturedPreviewUrl);
    state.capturedPreviewUrl = null;
  }
  els.capturedPreview.removeAttribute("src");
  els.capturedPreview.hidden = true;
  els.cameraPreview.hidden = false;
  els.capturePhoto.hidden = false;
  els.reviewControls.hidden = true;
}

async function sendCapturedPhoto() {
  if (!state.capturedBlob) return;

  const mime = state.capturedBlob.type || "image/jpeg";
  const extension = mime === "image/png" ? "png" : "jpg";
  const file = new File([state.capturedBlob], `photo-${timestampForFileName()}.${extension}`, {
    type: mime,
  });
  await sendFile(file);
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

function closeCamera() {
  if (state.cameraStream) {
    for (const track of state.cameraStream.getTracks()) {
      track.stop();
    }
    state.cameraStream = null;
  }

  if (els.cameraPreview) {
    els.cameraPreview.srcObject = null;
  }

  if (els.cameraPanel) {
    els.cameraPanel.hidden = true;
  }
}

function cleanup() {
  state.isClosing = true;
  window.clearTimeout(state.desktopRetryTimer);
  window.clearTimeout(state.phoneReconnectTimer);
  closeCamera();
  for (const url of [...state.objectUrls]) {
    revokeObjectUrl(url);
  }
  state.conn?.close?.();
  state.peer?.destroy?.();
}

function setPhoneReady(isReady) {
  const canInteract = isReady && !state.isCapturing;
  els.pickFile.disabled = !canInteract;
  els.openCamera.disabled = !canInteract;
  els.capturePhoto.disabled = !canInteract;
  els.retakePhoto.disabled = !canInteract;
  els.sendPhoto.disabled = !canInteract;
  els.chooseAnotherFile.disabled = state.isSending;
  els.sendSelectedFile.disabled = !canInteract || !state.pendingFile;
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

function timestampForFileName() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];
  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
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
