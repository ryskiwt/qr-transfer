export function getRoomIdFromPeerId(peerId) {
  return peerId.replace(/^qr-transfer-/, "");
}

export function formatRoomIdLabel(roomId, fits) {
  const fullLabel = `Room ID: ${roomId}`;
  if (fits(fullLabel)) return fullLabel;

  for (let size = Math.floor(roomId.length / 2); size >= 4; size -= 1) {
    const label = `Room ID: ${roomId.slice(0, size)}...${roomId.slice(-size)}`;
    if (fits(label)) return label;
  }

  return `Room ID: ${roomId.slice(0, 4)}...${roomId.slice(-4)}`;
}
