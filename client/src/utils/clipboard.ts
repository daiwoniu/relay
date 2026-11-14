/**
 * 复制文本到剪贴板 —— 兼容非 secure context（HTTP 非 localhost）
 * navigator.clipboard.writeText 只在 HTTPS 或 localhost 下可用
 */
export async function copyToClipboard(text: string): Promise<void> {
  // 优先用现代 API
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to fallback
    }
  }

  // Fallback: textarea + execCommand (兼容所有环境)
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('复制失败，请手动选择文本');
  } finally {
    document.body.removeChild(textarea);
  }
}
