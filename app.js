const TRANSFER_CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const TEXT_PREVIEW_LIMIT = 1024 * 1024;
const OBSOLETE_DESKTOP_PEER_STORAGE_KEY = "qr-transfer-desktop-peer-id";
const SESSION_SECRET_BYTES = 32;
const AUTH_NONCE_BYTES = 16;
const AES_GCM_IV_BYTES = 12;
const SECURE_PROTOCOL_VERSION = 1;
const MAX_TRANSFER_CHUNKS = 65536;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MIME_LENGTH = 128;
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
  refreshQr: document.querySelector("#refresh-qr"),
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
  connAuthenticated: false,
  targetPeerId: null,
  sessionSecret: null,
  sessionKeys: null,
  authNonce: null,
  phoneAuthFailed: false,
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
  receiverQueue: Promise.resolve(),
};

window.addEventListener("DOMContentLoaded", init);
window.addEventListener("beforeunload", cleanup);

function init() {
  clearObsoleteStorage();

  if (!window.Peer || !window.RTCPeerConnection || !isSecureCryptoSupported()) {
    showUnsupported("このブラウザではWebRTCまたは安全な暗号化を利用できません。");
    return;
  }

  bindEvents();

  const params = new URLSearchParams(window.location.search);
  const targetPeerId = params.get("peer");

  if (targetPeerId) {
    void startPhone(targetPeerId, readSessionSecretFromHash()).catch(() => {
      setPill("暗号化エラー", "error");
      els.phoneStatus.textContent = "暗号鍵を準備できませんでした。QRコードを読み取り直してください。";
    });
  } else {
    void startDesktop().catch(() => {
      showUnsupported("暗号鍵を準備できませんでした。HTTPSまたはlocalhostで開いてください。");
    });
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
  els.refreshQr.addEventListener("click", refreshDesktopSession);
  els.previewOverlay.addEventListener("click", handlePreviewOverlayClick);
  document.addEventListener("keydown", handleDocumentKeydown);
}

function showUnsupported(message = "このブラウザではWebRTCを利用できません。") {
  els.viewTitle.textContent = "WebRTCを利用できません";
  setPill("非対応", "error");
  els.desktopView.hidden = true;
  els.phoneView.hidden = true;
  els.unsupportedView.hidden = false;
  const status = els.unsupportedView.querySelector(".status-text");
  if (status) status.textContent = message;
}

async function startDesktop() {
  els.viewTitle.textContent = "WebRTCでファイルを受信";
  setPill("接続準備中");
  els.desktopView.hidden = false;
  els.phoneView.hidden = true;
  els.unsupportedView.hidden = true;
  setDesktopQrBusy("暗号鍵を準備中");

  const peerId = createPeerId();
  const sessionSecret = createSessionSecret();
  state.sessionSecret = sessionSecret;
  state.sessionKeys = await deriveSessionKeys(sessionSecret);
  ensureDesktopUrlHasRoom(peerId);
  createDesktopPeer(peerId);
}

function createDesktopPeer(peerId, retryCount = 0) {
  window.clearTimeout(state.desktopRetryTimer);
  setDesktopQrBusy(retryCount ? "接続IDを再利用できるまで待っています" : "QRコードを生成中");

  if (state.peer && !state.peer.destroyed) {
    state.peer.destroy();
  }
  state.conn?.close?.();
  state.conn = null;
  state.connAuthenticated = false;
  state.authNonce = null;
  state.incomingTransfers.clear();
  state.receiverQueue = Promise.resolve();

  const peer = createPeer(peerId);
  state.peer = peer;

  peer.on("open", (id) => {
    if (state.peer !== peer || state.isClosing) return;

    setPill("待機中", "warn");
    els.desktopStatus.textContent = "スマートフォンからの送信を待っています";

    const phoneUrl = buildPhoneUrl(id, state.sessionSecret);
    els.phoneLink.href = phoneUrl;
    els.phoneLink.textContent = formatPhoneUrlLabel(phoneUrl);
    els.phoneLink.title = els.phoneLink.textContent;
    renderQr(phoneUrl);
  });

  peer.on("connection", (conn) => {
    if (state.peer !== peer || state.isClosing) {
      conn.close();
      return;
    }

    if (state.conn?.open && state.connAuthenticated) {
      conn.close();
      return;
    }

    state.conn?.close?.();
    state.conn = conn;
    attachReceiver(conn);
  });

  peer.on("error", (error) => {
    if (state.peer !== peer || state.isClosing) return;

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
    els.refreshQr.disabled = false;
  });
}

function refreshDesktopSession() {
  if (els.desktopView.hidden || state.isClosing) return;

  const peerId = createPeerId();
  const sessionSecret = createSessionSecret();
  setDesktopQrBusy("暗号鍵を準備中");
  window.clearTimeout(state.desktopRetryTimer);
  state.conn?.close?.();
  state.peer?.destroy?.();
  state.conn = null;
  state.connAuthenticated = false;
  state.incomingTransfers.clear();
  state.sessionSecret = sessionSecret;
  void deriveSessionKeys(sessionSecret).then((sessionKeys) => {
    if (state.sessionSecret !== sessionSecret || state.isClosing) return;

    state.sessionKeys = sessionKeys;
    ensureDesktopUrlHasRoom(peerId);
    createDesktopPeer(peerId);
  }).catch(() => {
    setPill("暗号化エラー", "error");
    els.desktopStatus.textContent = "暗号鍵を準備できませんでした。ページを再読み込みしてください。";
    els.refreshQr.disabled = false;
  });
  setPill("再発行中", "warn");
  els.desktopStatus.textContent = "新しいQRコードを発行しています";
}

async function startPhone(targetPeerId, sessionSecret) {
  els.viewTitle.textContent = "WebRTCでファイルを送信";
  setPill("接続中", "warn");
  els.desktopView.hidden = true;
  els.phoneView.hidden = false;
  els.unsupportedView.hidden = true;
  setPhoneReady(false);

  if (!isValidSessionSecret(sessionSecret)) {
    setPill("QRエラー", "error");
    els.phoneStatus.textContent = "QRコードに秘密鍵が含まれていません。PC側でQRコードを再発行して読み取り直してください。";
    return;
  }

  state.targetPeerId = targetPeerId;
  state.sessionSecret = sessionSecret;
  state.sessionKeys = await deriveSessionKeys(sessionSecret);
  state.phoneAuthFailed = false;

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
  if (!state.peer?.open || !state.targetPeerId || !state.sessionKeys || state.isClosing) return;

  window.clearTimeout(state.phoneReconnectTimer);
  state.phoneReconnectTimer = null;

  if (state.conn?.open) return;

  setPill("接続中", "warn");
  setPhoneReady(false);
  els.phoneStatus.textContent = "PCへ接続しています";

  const conn = state.peer.connect(state.targetPeerId, {
    reliable: true,
    metadata: { role: "phone", secureProtocol: SECURE_PROTOCOL_VERSION },
  });
  state.conn = conn;
  state.connAuthenticated = false;
  state.phoneAuthFailed = false;
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

function buildPhoneUrl(peerId, sessionSecret) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("peer", peerId);
  url.hash = new URLSearchParams({ key: sessionSecret }).toString();
  return url.toString();
}

function formatPhoneUrlLabel(urlText) {
  const url = new URL(urlText);
  const peer = url.searchParams.get("peer") || "";
  const shortPeer = peer.length > 24 ? `${peer.slice(0, 18)}...${peer.slice(-6)}` : peer;

  return `${url.host}${url.pathname}?peer=${shortPeer}#key=...`;
}

function ensureDesktopUrlHasRoom(peerId) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("room") === peerId) return;

  url.search = "";
  url.hash = "";
  url.searchParams.set("room", peerId);
  window.history.replaceState(null, "", url);
}

function createPeerId() {
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);

  return `qr-transfer-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function createSessionSecret() {
  return bytesToBase64Url(createRandomBytes(SESSION_SECRET_BYTES));
}

function createAuthNonce() {
  return bytesToBase64Url(createRandomBytes(AUTH_NONCE_BYTES));
}

function createRandomBytes(length) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return bytes;
}

function readSessionSecretFromHash() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  return new URLSearchParams(hash).get("key") || "";
}

function isValidSessionSecret(secret) {
  try {
    return base64UrlToBytes(secret).byteLength === SESSION_SECRET_BYTES;
  } catch {
    return false;
  }
}

function isSecureCryptoSupported() {
  return Boolean(window.crypto?.getRandomValues && window.crypto?.subtle && window.TextEncoder && window.TextDecoder);
}

async function deriveSessionKeys(sessionSecret) {
  const secretBytes = base64UrlToBytes(sessionSecret);
  const baseKey = await window.crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveKey"]);
  const salt = encodeText("qr-transfer-v1");

  const authKey = await window.crypto.subtle.deriveKey(
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

  const encryptionKey = await window.crypto.subtle.deriveKey(
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

function encodeText(text) {
  return new TextEncoder().encode(text);
}

function decodeText(bytes) {
  return new TextDecoder().decode(bytes);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error("Invalid base64url text");
  }

  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function renderQr(url) {
  if (!window.QRCode) {
    els.qrLoading.textContent = "QRコードを生成できません。下のリンクをスマートフォンで開いてください。";
    els.refreshQr.disabled = false;
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
  els.qrCode.removeAttribute("title");
  els.qrLoading.hidden = true;
  els.refreshQr.disabled = false;
}

function setDesktopQrBusy(message) {
  els.refreshQr.disabled = true;
  els.phoneLink.removeAttribute("href");
  els.phoneLink.textContent = "スマートフォン用リンクを準備中";
  els.phoneLink.title = "";
  els.qrCode.replaceChildren();
  els.qrLoading.textContent = message;
  els.qrLoading.hidden = false;
}

function attachReceiver(conn) {
  state.connAuthenticated = false;
  state.receiverQueue = Promise.resolve();
  setPill("認証中", "warn");
  els.desktopStatus.textContent = "スマートフォンとの接続を確認しています";

  conn.on("open", () => {
    if (state.conn !== conn || state.isClosing) return;

    setPill("認証中", "warn");
  });

  conn.on("data", (data) => {
    if (state.conn !== conn || state.isClosing) return;

    state.receiverQueue = state.receiverQueue
      .then(() => handleIncomingData(data, conn))
      .catch(() => {
        if (state.conn !== conn || state.isClosing) return;

        setPill("受信エラー", "error");
        els.desktopStatus.textContent = "受信データを復号できませんでした。QRコードを再発行してください。";
        state.conn = null;
        state.connAuthenticated = false;
        conn.close();
      });
  });

  conn.on("close", () => {
    if (state.conn !== conn || state.isClosing) return;

    state.connAuthenticated = false;
    setPill("切断", "warn");
    els.desktopStatus.textContent = "スマートフォンからの再接続を待っています";
  });

  conn.on("error", () => {
    if (state.conn !== conn || state.isClosing) return;

    state.connAuthenticated = false;
    setPill("受信エラー", "error");
    els.desktopStatus.textContent = "受信中にエラーが発生しました。接続をやり直してください。";
  });
}

function attachSender(conn) {
  conn.on("open", () => {
    if (state.conn !== conn) return;

    state.phoneReconnectAttempts = 0;
    state.connAuthenticated = false;
    setPill("認証中", "warn");
    setPhoneReady(false);
    els.phoneStatus.textContent = "PCとの接続を確認しています";
    void sendAuthHello(conn);
  });

  conn.on("data", (data) => {
    if (state.conn !== conn || state.isClosing) return;

    void handleSenderData(data, conn);
  });

  conn.on("close", () => {
    if (state.conn !== conn || state.isClosing) return;

    state.connAuthenticated = false;
    if (state.phoneAuthFailed) return;

    setPill("再接続中", "warn");
    setPhoneReady(false);
    els.phoneStatus.textContent = "PCへ再接続しています";
    schedulePhoneReconnect();
  });

  conn.on("error", () => {
    if (state.conn !== conn || state.isClosing) return;

    state.connAuthenticated = false;
    if (state.phoneAuthFailed) return;

    setPill("再接続中", "warn");
    setPhoneReady(false);
    els.phoneStatus.textContent = "PCへ再接続しています";
    schedulePhoneReconnect();
  });
}

async function sendAuthHello(conn) {
  try {
    const nonce = createAuthNonce();
    state.authNonce = nonce;
    const token = await signAuthMessage(createAuthMessage("phone", nonce));

    if (state.conn !== conn || !conn.open || state.isClosing) return;

    conn.send({
      type: "auth-hello",
      version: SECURE_PROTOCOL_VERSION,
      nonce,
      token,
    });
  } catch {
    if (state.conn !== conn || state.isClosing) return;

    state.phoneAuthFailed = true;
    setPill("認証エラー", "error");
    setPhoneReady(false);
    els.phoneStatus.textContent = "接続認証を開始できませんでした。QRコードを読み取り直してください。";
    conn.close();
  }
}

async function handleAuthHello(data, conn) {
  if (
    data.version !== SECURE_PROTOCOL_VERSION ||
    typeof data.nonce !== "string" ||
    typeof data.token !== "string"
  ) {
    rejectUnauthenticatedConnection(conn);
    return;
  }

  const isValid = await verifyAuthMessage(createAuthMessage("phone", data.nonce), data.token);
  if (!isValid) {
    rejectUnauthenticatedConnection(conn);
    return;
  }

  const token = await signAuthMessage(createAuthMessage("desktop", data.nonce));
  if (state.conn !== conn || !conn.open || state.isClosing) return;

  state.connAuthenticated = true;
  setPill("接続済み", "success");
  els.desktopStatus.textContent = "スマートフォンからの送信を待っています";
  conn.send({
    type: "auth-ok",
    version: SECURE_PROTOCOL_VERSION,
    nonce: data.nonce,
    token,
  });
}

async function handleSenderData(data, conn) {
  if (!data || typeof data !== "object") return;

  if (data.type === "auth-error") {
    state.connAuthenticated = false;
    state.phoneAuthFailed = true;
    setPill("認証エラー", "error");
    setPhoneReady(false);
    els.phoneStatus.textContent = "PCとの接続認証に失敗しました。QRコードを読み取り直してください。";
    conn.close();
    return;
  }

  if (data.type !== "auth-ok") return;

  if (
    data.version !== SECURE_PROTOCOL_VERSION ||
    data.nonce !== state.authNonce ||
    typeof data.token !== "string"
  ) {
    state.connAuthenticated = false;
    state.phoneAuthFailed = true;
    setPill("認証エラー", "error");
    setPhoneReady(false);
    els.phoneStatus.textContent = "PCからの認証応答を確認できませんでした。QRコードを読み取り直してください。";
    conn.close();
    return;
  }

  const isValid = await verifyAuthMessage(createAuthMessage("desktop", data.nonce), data.token);
  if (state.conn !== conn || state.isClosing) return;

  if (!isValid) {
    state.connAuthenticated = false;
    state.phoneAuthFailed = true;
    setPill("認証エラー", "error");
    setPhoneReady(false);
    els.phoneStatus.textContent = "PCとの接続認証に失敗しました。QRコードを読み取り直してください。";
    conn.close();
    return;
  }

  state.connAuthenticated = true;
  state.phoneAuthFailed = false;
  state.authNonce = null;
  setPill("接続済み", "success");
  setPhoneReady(isConnectionReady());
  els.phoneStatus.textContent = "暗号化接続を確認しました。送信するファイルを選択してください";
}

function rejectUnauthenticatedConnection(conn) {
  if (state.conn === conn && !state.isClosing) {
    state.connAuthenticated = false;
    setPill("認証エラー", "error");
    els.desktopStatus.textContent = "接続認証に失敗しました。QRコードを再発行してください。";
    state.conn = null;
  }

  if (conn.open) {
    conn.send({ type: "auth-error", version: SECURE_PROTOCOL_VERSION });
    conn.close();
  }
}

function createAuthMessage(role, nonce) {
  return `qr-transfer-v${SECURE_PROTOCOL_VERSION}|auth|${role}|${nonce}`;
}

async function signAuthMessage(message) {
  const signature = await window.crypto.subtle.sign("HMAC", state.sessionKeys.authKey, encodeText(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyAuthMessage(message, token) {
  try {
    return await window.crypto.subtle.verify(
      "HMAC",
      state.sessionKeys.authKey,
      base64UrlToBytes(token),
      encodeText(message),
    );
  } catch {
    return false;
  }
}

async function encryptFileMeta(meta) {
  return {
    type: "file-meta",
    id: meta.id,
    encrypted: true,
    payload: await encryptJsonPayload(meta, createFileMetaAad(meta.id)),
  };
}

async function decryptFileMeta(data) {
  if (data.encrypted !== true || typeof data.id !== "string") {
    throw new Error("Unencrypted file metadata is not accepted");
  }

  const meta = await decryptJsonPayload(data.payload, createFileMetaAad(data.id));
  return normalizeFileMeta(meta, data.id);
}

async function encryptFileChunk({ id, index, byteLength, chunk }) {
  return {
    type: "file-chunk",
    id,
    index,
    byteLength,
    encrypted: true,
    payload: await encryptBinaryPayload(chunk, createFileChunkAad(id, index, byteLength)),
  };
}

async function decryptFileChunk(data) {
  if (
    data.encrypted !== true ||
    typeof data.id !== "string" ||
    !Number.isSafeInteger(data.index) ||
    !Number.isSafeInteger(data.byteLength) ||
    data.index < 0 ||
    data.byteLength < 0 ||
    data.byteLength > TRANSFER_CHUNK_SIZE
  ) {
    throw new Error("Invalid encrypted file chunk");
  }

  const chunk = await decryptBinaryPayload(data.payload, createFileChunkAad(data.id, data.index, data.byteLength));
  if (chunk.byteLength !== data.byteLength) {
    throw new Error("Decrypted chunk size mismatch");
  }
  return chunk;
}

async function encryptJsonPayload(value, additionalData) {
  return encryptBinaryPayload(encodeText(JSON.stringify(value)), additionalData);
}

async function decryptJsonPayload(payload, additionalData) {
  const buffer = await decryptBinaryPayload(payload, additionalData);
  return JSON.parse(decodeText(new Uint8Array(buffer)));
}

async function encryptBinaryPayload(value, additionalData) {
  const iv = createRandomBytes(AES_GCM_IV_BYTES);
  const data = toArrayBuffer(value);
  const ciphertext = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encodeText(additionalData),
    },
    state.sessionKeys.encryptionKey,
    data,
  );

  return {
    iv: iv.buffer,
    data: ciphertext,
  };
}

async function decryptBinaryPayload(payload, additionalData) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Missing encrypted payload");
  }

  const iv = toUint8Array(payload.iv);
  if (iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new Error("Invalid AES-GCM IV length");
  }

  return window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encodeText(additionalData),
    },
    state.sessionKeys.encryptionKey,
    toArrayBuffer(payload.data),
  );
}

function normalizeFileMeta(meta, id) {
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

function createFileMetaAad(id) {
  return `qr-transfer-v${SECURE_PROTOCOL_VERSION}|file-meta|${id}`;
}

function createFileChunkAad(id, index, byteLength) {
  return `qr-transfer-v${SECURE_PROTOCOL_VERSION}|file-chunk|${id}|${index}|${byteLength}`;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  throw new Error("Expected binary data");
}

function toArrayBuffer(value) {
  const bytes = toUint8Array(value);
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }

  return bytes.slice().buffer;
}

async function handleIncomingData(data, conn) {
  if (!data || typeof data !== "object") return;

  if (data.type === "auth-hello") {
    await handleAuthHello(data, conn);
    return;
  }

  if (!state.connAuthenticated) {
    rejectUnauthenticatedConnection(conn);
    return;
  }

  if (data.type === "file-meta") {
    const meta = await decryptFileMeta(data);
    state.incomingTransfers.set(meta.id, {
      meta,
      chunks: new Array(meta.totalChunks),
      receivedBytes: 0,
      receivedChunks: 0,
      element: createReceivingItem(meta),
    });
    els.desktopStatus.textContent = `${meta.name} を受信しています`;
    return;
  }

  if (data.type === "file-chunk") {
    const transfer = state.incomingTransfers.get(data.id);
    if (!transfer) return;
    if (!isValidChunkEnvelope(data, transfer.meta) || transfer.chunks[data.index]) {
      throw new Error("Invalid file chunk");
    }

    const chunk = await decryptFileChunk(data);
    transfer.chunks[data.index] = chunk;
    transfer.receivedChunks += 1;
    transfer.receivedBytes += data.byteLength;
    updateReceivingItem(transfer);

    if (transfer.receivedChunks === transfer.meta.totalChunks) {
      completeReceivingItem(data.id, transfer);
    }
  }
}

function isValidChunkEnvelope(data, meta) {
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
      setPhoneReady(isConnectionReady());
    }
  } finally {
    if (requestId === state.appCameraRequestId) {
      state.isOpeningAppCamera = false;
      setPhoneReady(isConnectionReady());
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
    setPhoneReady(isConnectionReady());
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
    setPhoneReady(isConnectionReady());
  } finally {
    state.isCapturingAppCamera = false;
    canvas.width = 0;
    canvas.height = 0;
    setPhoneReady(isConnectionReady());
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
  setPhoneReady(isConnectionReady());
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
    window.localStorage?.removeItem(OBSOLETE_DESKTOP_PEER_STORAGE_KEY);
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
  setPhoneReady(isConnectionReady());
}

function closeAppCamera() {
  stopAppCameraStream();
  els.phoneStatus.textContent = "送信するファイルを選択してください";
  setPhoneReady(isConnectionReady());
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
  if (!conn?.open || !state.connAuthenticated || state.isSending) return false;

  const totalChunks = Math.max(1, Math.ceil(file.size / TRANSFER_CHUNK_SIZE));
  if (!canSendFile(file, totalChunks)) {
    setPill("送信不可", "error");
    els.phoneStatus.textContent = "このファイルは送信できません。ファイル名またはサイズを確認してください。";
    return false;
  }

  state.isSending = true;
  setPhoneReady(false);
  setPill("送信中", "warn");
  els.sendProgress.hidden = false;
  els.sendProgress.value = 0;
  els.phoneStatus.textContent = `${file.name} を送信しています`;

  const id = window.crypto.randomUUID?.() || `transfer-${bytesToBase64Url(createRandomBytes(16))}`;

  const meta = {
    name: file.name,
    mime: file.type,
    size: file.size,
    totalChunks,
    id,
  };

  let didSend = false;

  try {
    conn.send(await encryptFileMeta(meta));

    for (let index = 0; index < totalChunks; index += 1) {
      await waitForBuffer(conn);
      if (!conn.open || !state.connAuthenticated) throw new Error("Data connection closed");

      const start = index * TRANSFER_CHUNK_SIZE;
      const end = Math.min(file.size, start + TRANSFER_CHUNK_SIZE);
      const chunk = await file.slice(start, end).arrayBuffer();

      conn.send(await encryptFileChunk({
        id,
        index,
        byteLength: chunk.byteLength,
        chunk,
      }));

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
    setPhoneReady(isConnectionReady());
    els.sendProgress.hidden = true;
  }

  return didSend;
}

function canSendFile(file, totalChunks) {
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

function isConnectionReady() {
  return Boolean(state.conn?.open && state.connAuthenticated);
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
