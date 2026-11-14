/** 生成 UUID v4 —— 兼容所有浏览器环境（含非 secure context 的 HTTP 访问） */
export function generateUUID(): string {
  // crypto.randomUUID() 仅在 secure context (HTTPS/localhost) 可用
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // fallback: 手动生成 UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
