const TRANSFER_CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const TEXT_PREVIEW_LIMIT = 1024 * 1024;
const DESKTOP_PEER_STORAGE_KEY = "qr-transfer-desktop-peer-id";
const PHONE_RECONNECT_BASE_DELAY = 700;
const PHONE_RECONNECT_MAX_DELAY = 5000;
const APP_CAMERA_MAX_LONG_EDGE = 1920;
const APP_CAMERA_MAX_SHORT_EDGE = 1440;
const APP_CAMERA_JPEG_QUALITY = 0.88;
const APP_CAMERA_READY_TIMEOUT_MS = 8000;
const FILE_IMAGE_PREVIEW_MAX_PIXELS = 8 * 1000 * 1000;
const IMAGE_HEADER_READ_BYTES = 512 * 1024;

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
  openPreviewOverlay: document.querySelector("#open-preview-overlay"),
  previewOverlay: document.querySelector("#preview-overlay"),
  previewOverlayTitle: document.querySelector("#preview-overlay-title"),
  previewOverlayDetail: document.querySelector("#preview-overlay-detail"),
  previewOverlayContent: document.querySelector("#preview-overlay-content"),
  closePreviewOverlay: document.querySelector("#close-preview-overlay"),
  pickFile: document.querySelector("#pick-file"),
  openAppCamera: document.querySelector("#open-app-camera"),
  fileInput: document.querySelector("#file-input"),
  appCameraPanel: document.querySelector("#app-camera-panel"),
  appCameraVideo: document.querySelector("#app-camera-video"),
  closeAppCamera: document.querySelector("#close-app-camera"),
  captureAppCamera: document.querySelector("#capture-app-camera"),
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
  appCameraStream: null,
  appCameraRequestId: 0,
  appCameraSensorRotation: 0,
  appCameraSensorRotationAt: 0,
  appCameraOrientationTracking: false,
  appCameraOrientationPermissionRequested: false,
  isOpeningAppCamera: false,
  isCapturingAppCamera: false,
  currentReceivedPreview: null,
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
  clearObsoleteStorage();

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
  els.openAppCamera.addEventListener("click", openAppCamera);
  els.closeAppCamera.addEventListener("click", closeAppCamera);
  els.captureAppCamera.addEventListener("click", captureAppCamera);
  els.openPreviewOverlay.addEventListener("click", openPreviewOverlay);
  els.closePreviewOverlay.addEventListener("click", closePreviewOverlay);
  els.previewOverlay.addEventListener("click", handlePreviewOverlayClick);
  document.addEventListener("keydown", handleDocumentKeydown);
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
    els.phoneLink.textContent = formatPhoneUrlLabel(phoneUrl);
    els.phoneLink.title = phoneUrl;
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

function formatPhoneUrlLabel(urlText) {
  const url = new URL(urlText);
  const peer = url.searchParams.get("peer") || "";
  const shortPeer = peer.length > 24 ? `${peer.slice(0, 18)}...${peer.slice(-6)}` : peer;

  return `${url.host}${url.pathname}?peer=${shortPeer}`;
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
  state.currentReceivedPreview = { blob, meta, url };
  els.previewName.textContent = meta.name;
  els.previewDetail.textContent = `${formatBytes(blob.size)} / ${meta.mime || "application/octet-stream"}`;
  els.openPreviewOverlay.hidden = false;
  await renderFilePreview(els.previewContent, { blob, meta, url });

  if (!els.previewOverlay.hidden) {
    await renderPreviewOverlay({ blob, meta, url });
  }
}

async function openPreviewOverlay() {
  if (!state.currentReceivedPreview) return;

  await renderPreviewOverlay(state.currentReceivedPreview);
  els.previewOverlay.hidden = false;
  els.closePreviewOverlay.focus();
}

async function renderPreviewOverlay({ blob, meta, url }) {
  els.previewOverlayTitle.textContent = meta.name;
  els.previewOverlayDetail.textContent = `${formatBytes(blob.size)} / ${meta.mime || "application/octet-stream"}`;
  await renderFilePreview(els.previewOverlayContent, { blob, meta, url });
}

function closePreviewOverlay() {
  els.previewOverlay.hidden = true;
  els.previewOverlayContent.replaceChildren();
  els.previewOverlayContent.dataset.previewKind = "empty";
}

function handlePreviewOverlayClick(event) {
  if (event.target === els.previewOverlay) {
    closePreviewOverlay();
  }
}

function handleDocumentKeydown(event) {
  if (event.key === "Escape" && !els.previewOverlay.hidden) {
    closePreviewOverlay();
  }
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
  const files = event.target.files || [];
  const [file] = files;
  event.target.value = "";
  if (!file) return;

  try {
    await showSelectedFilePreview(file, "file");
  } catch {
    els.phoneStatus.textContent = "プレビュー処理中にエラーが発生しました。送信はやり直してください。";
    clearPendingFile();
  }
}

async function openAppCamera() {
  clearPendingFile();

  if (!navigator.mediaDevices?.getUserMedia) {
    els.phoneStatus.textContent = "このブラウザではアプリ内カメラを利用できません。";
    return;
  }

  const requestId = state.appCameraRequestId + 1;
  state.appCameraRequestId = requestId;
  state.isOpeningAppCamera = true;
  els.appCameraPanel.hidden = false;
  els.phoneStatus.textContent = "アプリ内カメラを起動しています";
  setPhoneReady(false);

  try {
    await ensureAppCameraOrientationTracking();
    const stream = await getBoundedCameraStream();
    if (requestId !== state.appCameraRequestId) {
      stopMediaStream(stream);
      return;
    }

    state.appCameraStream = stream;
    els.appCameraVideo.srcObject = stream;
    await waitForVideoReady(els.appCameraVideo);
    await els.appCameraVideo.play();
    if (requestId !== state.appCameraRequestId) {
      stopMediaStream(stream);
      if (state.appCameraStream === stream) {
        state.appCameraStream = null;
        els.appCameraVideo.srcObject = null;
      }
      return;
    }

    els.phoneStatus.textContent = "アプリ内カメラで撮影できます";
  } catch {
    if (requestId === state.appCameraRequestId) {
      stopAppCameraStream();
      els.appCameraPanel.hidden = true;
      els.phoneStatus.textContent = "アプリ内カメラを起動できませんでした。カメラを起動する方法を試してください。";
      setPhoneReady(Boolean(state.conn?.open));
    }
  } finally {
    if (requestId === state.appCameraRequestId) {
      state.isOpeningAppCamera = false;
      setPhoneReady(Boolean(state.conn?.open));
    }
  }
}

async function getBoundedCameraStream() {
  const candidates = [
    {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1600, max: APP_CAMERA_MAX_LONG_EDGE },
        height: { ideal: 1200, max: APP_CAMERA_MAX_LONG_EDGE },
        resizeMode: "crop-and-scale",
      },
    },
    {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280, max: APP_CAMERA_MAX_LONG_EDGE },
        height: { ideal: 960, max: APP_CAMERA_MAX_LONG_EDGE },
      },
    },
    {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
      },
    },
  ];

  let lastError = null;
  for (const constraints of candidates) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Camera unavailable");
}

function waitForVideoReady(video) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(handleTimeout, APP_CAMERA_READY_TIMEOUT_MS);
    const cleanupListeners = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
    };
    const handleLoaded = () => {
      cleanupListeners();
      resolve();
    };
    const handleError = () => {
      cleanupListeners();
      reject(new Error("Video unavailable"));
    };
    function handleTimeout() {
      cleanupListeners();
      reject(new Error("Video metadata timeout"));
    }

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
  });
}

async function captureAppCamera() {
  const video = els.appCameraVideo;
  if (state.isCapturingAppCamera || !state.appCameraStream || !video.videoWidth || !video.videoHeight) return;

  state.isCapturingAppCamera = true;
  setPhoneReady(false);
  els.phoneStatus.textContent = "撮影した写真を作成しています";

  const canvas = document.createElement("canvas");
  const capture = getAppCameraCapture(video);
  canvas.width = capture.width;
  canvas.height = capture.height;

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    state.isCapturingAppCamera = false;
    canvas.width = 0;
    canvas.height = 0;
    stopAppCameraStream();
    els.phoneStatus.textContent = "撮影画像を作成できませんでした。";
    setPhoneReady(Boolean(state.conn?.open));
    return;
  }

  drawAppCameraFrame(context, video, capture);

  try {
    const blob = await canvasToBlob(canvas, "image/jpeg", APP_CAMERA_JPEG_QUALITY);
    const file = new File([blob], createCameraFileName(), {
      type: "image/jpeg",
      lastModified: Date.now(),
    });

    await showSelectedFilePreview(file, "app-camera");
    els.phoneStatus.textContent = "撮影した写真を確認してください";
  } catch {
    els.phoneStatus.textContent = "撮影画像を作成できませんでした。もう一度撮影してください。";
    setPhoneReady(Boolean(state.conn?.open));
  } finally {
    state.isCapturingAppCamera = false;
    canvas.width = 0;
    canvas.height = 0;
    setPhoneReady(Boolean(state.conn?.open));
  }
}

function calculateBoundedImageSize(width, height) {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const scale = Math.min(1, APP_CAMERA_MAX_LONG_EDGE / longEdge, APP_CAMERA_MAX_SHORT_EDGE / shortEdge);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function getAppCameraCapture(video) {
  const rotation = getAppCameraRotation(video);
  const isSideways = Math.abs(rotation) === 90;
  const outputWidth = isSideways ? video.videoHeight : video.videoWidth;
  const outputHeight = isSideways ? video.videoWidth : video.videoHeight;

  return {
    ...calculateBoundedImageSize(outputWidth, outputHeight),
    rotation,
  };
}

function getAppCameraRotation(video) {
  if (video.videoWidth >= video.videoHeight) return 0;

  const sensorRotation = getFreshAppCameraSensorRotation();
  if (sensorRotation) return sensorRotation;

  return getLandscapeOrientationRotation();
}

function getLandscapeOrientationRotation() {
  const type = screen.orientation?.type || "";
  if (type === "landscape-secondary") return -90;
  if (type === "landscape-primary") return 90;

  const angle = getOrientationAngle();
  if (angle === -90 || angle === 270) return -90;
  if (angle === 90 || angle === -270) return 90;

  if (!isViewportLandscape()) return 0;
  return 90;
}

function getFreshAppCameraSensorRotation() {
  if (Date.now() - state.appCameraSensorRotationAt > 5000) return 0;

  return state.appCameraSensorRotation;
}

async function ensureAppCameraOrientationTracking() {
  if (state.appCameraOrientationTracking || typeof DeviceOrientationEvent === "undefined") return;

  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    if (state.appCameraOrientationPermissionRequested) return;

    state.appCameraOrientationPermissionRequested = true;
    try {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") return;
    } catch {
      return;
    }
  }

  window.addEventListener("deviceorientation", handleAppCameraDeviceOrientation, true);
  state.appCameraOrientationTracking = true;
}

function handleAppCameraDeviceOrientation(event) {
  if (typeof event.gamma !== "number") return;

  const gamma = event.gamma;
  if (Math.abs(gamma) >= 45) {
    state.appCameraSensorRotation = gamma > 0 ? 90 : -90;
    state.appCameraSensorRotationAt = Date.now();
    return;
  }

  if (Math.abs(gamma) <= 25) {
    state.appCameraSensorRotation = 0;
    state.appCameraSensorRotationAt = Date.now();
  }
}

function isViewportLandscape() {
  const viewport = window.visualViewport;
  if (viewport?.width && viewport?.height && viewport.width > viewport.height) return true;

  return window.matchMedia?.("(orientation: landscape)")?.matches || window.innerWidth > window.innerHeight;
}

function getOrientationAngle() {
  if (typeof screen.orientation?.angle === "number") return screen.orientation.angle;
  if (typeof window.orientation === "number") return window.orientation;

  return 0;
}

function drawAppCameraFrame(context, video, capture) {
  if (capture.rotation === 90) {
    context.translate(capture.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(video, 0, 0, capture.height, capture.width);
    return;
  }

  if (capture.rotation === -90) {
    context.translate(0, capture.height);
    context.rotate(-Math.PI / 2);
    context.drawImage(video, 0, 0, capture.height, capture.width);
    return;
  }

  context.drawImage(video, 0, 0, capture.width, capture.height);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to create image blob"));
      }
    }, type, quality);
  });
}

function createCameraFileName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `qr-transfer-camera-${timestamp}.jpg`;
}

async function showSelectedFilePreview(file, source) {
  clearPendingFile();

  const skipPreviewMessage = await getSelectedFilePreviewSkipMessage(file, source);
  const url = skipPreviewMessage ? null : createObjectUrl(file);
  state.pendingFile = file;
  state.pendingSource = source;
  state.pendingFileUrl = url;

  els.fileReviewPanel.hidden = false;
  els.fileReviewName.textContent = file.name;
  els.fileReviewDetail.textContent = formatSelectedFileDetail(file);
  els.chooseAnotherFile.textContent = source === "app-camera" ? "撮り直す" : "選び直す";
  if (url) {
    await renderFilePreview(els.fileReviewContent, {
      blob: file,
      meta: {
        name: file.name,
        mime: file.type,
      },
      url,
    });
  } else {
    renderPreviewMessage(els.fileReviewContent, skipPreviewMessage);
  }
  els.phoneStatus.textContent = "送信するファイルを確認してください";
  setPhoneReady(Boolean(state.conn?.open));
}

async function getSelectedFilePreviewSkipMessage(file, source) {
  if (source !== "file" || !isImageFile(file)) return "";
  if (isSvgFile(file)) return "";

  const dimensions = await readImageDimensions(file).catch(() => null);
  if (!dimensions) {
    return `画像サイズを安全に確認できないためスマートフォン側プレビューを省略します。${formatBytes(file.size)}`;
  }

  const pixels = dimensions.width * dimensions.height;
  if (pixels <= FILE_IMAGE_PREVIEW_MAX_PIXELS) return "";

  return `画像が大きいためスマートフォン側プレビューを省略します。${dimensions.width} x ${dimensions.height}px / ${formatBytes(file.size)}`;
}

async function readImageDimensions(file) {
  if (isJpegFile(file)) return readJpegDimensions(file);
  if (isPngFile(file)) return readPngDimensions(file);
  if (isGifFile(file)) return readGifDimensions(file);
  if (isWebpFile(file)) return readWebpDimensions(file);

  return null;
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name);
}

function isSvgFile(file) {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}

async function readJpegDimensions(file) {
  const buffer = await file.slice(0, Math.min(file.size, IMAGE_HEADER_READ_BYTES)).arrayBuffer();
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 9 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;

    const marker = view.getUint8(offset + 1);
    if (marker === 0xda || marker === 0xd9) return null;

    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > view.byteLength) return null;

    if (isJpegStartOfFrame(marker)) {
      return {
        width: view.getUint16(offset + 7),
        height: view.getUint16(offset + 5),
      };
    }

    offset += 2 + length;
  }

  return null;
}

async function readPngDimensions(file) {
  const view = await readFileHeader(file, 24);
  if (view.byteLength < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
    return null;
  }

  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

async function readGifDimensions(file) {
  const view = await readFileHeader(file, 10);
  if (view.byteLength < 10) return null;

  const signature = readHeaderAscii(view, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;

  return {
    width: view.getUint16(6, true),
    height: view.getUint16(8, true),
  };
}

async function readWebpDimensions(file) {
  const view = await readFileHeader(file, 64);
  if (view.byteLength < 30 || readHeaderAscii(view, 0, 4) !== "RIFF" || readHeaderAscii(view, 8, 4) !== "WEBP") {
    return null;
  }

  const chunkType = readHeaderAscii(view, 12, 4);
  if (chunkType === "VP8X") {
    return {
      width: readUint24LE(view, 24) + 1,
      height: readUint24LE(view, 27) + 1,
    };
  }

  if (chunkType === "VP8 " && view.byteLength >= 30) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }

  if (chunkType === "VP8L" && view.byteLength >= 25 && view.getUint8(20) === 0x2f) {
    const b0 = view.getUint8(21);
    const b1 = view.getUint8(22);
    const b2 = view.getUint8(23);
    const b3 = view.getUint8(24);

    return {
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }

  return null;
}

async function readFileHeader(file, bytes) {
  return new DataView(await file.slice(0, Math.min(file.size, bytes)).arrayBuffer());
}

function isJpegFile(file) {
  return file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
}

function isPngFile(file) {
  return file.type === "image/png" || /\.png$/i.test(file.name);
}

function isGifFile(file) {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

function isWebpFile(file) {
  return file.type === "image/webp" || /\.webp$/i.test(file.name);
}

function isJpegStartOfFrame(marker) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readHeaderAscii(view, start, length) {
  if (start + length > view.byteLength) return "";

  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(view.getUint8(start + index));
  }
  return text;
}

function readUint24LE(view, offset) {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}

function formatSelectedFileDetail(file) {
  return `${formatBytes(file.size)} / ${file.type || "application/octet-stream"}`;
}

function clearObsoleteStorage() {
  try {
    window.localStorage?.removeItem("qr-transfer-debug-log");
  } catch {
    // Ignore storage cleanup failures.
  }
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
  if (source === "app-camera") {
    void openAppCamera();
    return;
  }

  els.fileInput.click();
}

async function sendSelectedFile() {
  if (!state.pendingFile) return;

  const source = state.pendingSource;
  const didSend = await sendFile(state.pendingFile);
  if (didSend && source !== "app-camera") {
    clearPendingFile();
  }
}

function clearPendingFile() {
  stopAppCameraStream();
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

function closeAppCamera() {
  stopAppCameraStream();
  els.phoneStatus.textContent = "送信するファイルを選択してください";
  setPhoneReady(Boolean(state.conn?.open));
}

function stopAppCameraStream() {
  state.appCameraRequestId += 1;
  stopMediaStream(state.appCameraStream);

  state.appCameraStream = null;
  state.isOpeningAppCamera = false;
  els.appCameraVideo.pause();
  els.appCameraVideo.srcObject = null;
  els.appCameraPanel.hidden = true;
}

function stopMediaStream(stream) {
  for (const track of stream?.getTracks?.() || []) {
    track.stop();
  }
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
  window.removeEventListener("deviceorientation", handleAppCameraDeviceOrientation, true);
  stopAppCameraStream();
  for (const url of [...state.objectUrls]) {
    revokeObjectUrl(url);
  }
  state.conn?.close?.();
  state.peer?.destroy?.();
}

function setPhoneReady(isReady) {
  const appCameraBusy = state.isOpeningAppCamera || Boolean(state.appCameraStream);

  els.pickFile.disabled = !isReady || appCameraBusy;
  els.openAppCamera.disabled = !isReady || appCameraBusy;
  els.captureAppCamera.disabled = !state.appCameraStream || state.isSending || state.isCapturingAppCamera;
  els.closeAppCamera.disabled = state.isSending || state.isCapturingAppCamera;
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
