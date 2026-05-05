export function getSelectedFilePreviewSkipMessage(file, source, formatBytes) {
  if (source !== "file") return "";

  return `スマートフォン側プレビューは省略します。${formatBytes(file.size)}`;
}
