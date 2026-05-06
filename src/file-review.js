export function getSelectedFilePreviewSkipMessage(file, source, formatBytes) {
  if (source !== "file") return "";

  return `送信側プレビューは省略します。${formatBytes(file.size)}`;
}
