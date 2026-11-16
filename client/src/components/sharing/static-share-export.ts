const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const STATIC_SHARE_SCRIPT_HASH = 'mHMT+UMQiCVsplyeOATETTtk5alGSjf+pvCiVw6/bhY=';

export async function readStaticShareScript(
  response: Response,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle || null,
): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !/^(?:text|application)\/javascript(?:;|$)/i.test(contentType)) {
    throw new Error('离线脚本响应无效');
  }
  const script = await response.text();
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(script));
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if (hash !== STATIC_SHARE_SCRIPT_HASH) throw new Error('离线脚本完整性校验失败');
  }
  return script;
}

export function sanitizeStaticShareFilename(title: string): string {
  let name = title.trim().replace(/[<>:"/\\|?*：\u0000-\u001f]/g, '_').slice(0, 80).replace(/[ .]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `Relay_${name}`;
  return `${name || 'Relay 分享'}.html`;
}

export function buildStaticShareHtml(title: string, content: string, css: string, script: string, theme = 'light'): string {
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html lang=zh-CN data-theme="${escapeHtml(theme)}" data-static-share-document><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta http-equiv=Content-Security-Policy content="default-src 'none';script-src 'sha256-${STATIC_SHARE_SCRIPT_HASH}';style-src 'unsafe-inline';form-action 'none'"><title>${escapeHtml(`${title} · Relay 分享`)}</title><style>${safeCss}
html[data-static-share-document]{height:auto!important;min-height:100%;overflow-y:auto!important}html[data-static-share-document] body{height:auto!important;min-height:100%;overflow-y:visible!important}html[data-static-share-document] [data-static-share-root]{height:auto!important;min-height:100vh;overflow-y:visible!important}
[data-static-share-offline]{display:block!important}
[data-static-share-exclude],.message-action-button,[data-message-copy-exclude]{display:none!important}</style><body>${content}<script>${script}</script></body></html>`;
}

export function prepareStaticShareRoot(root: HTMLElement, exportedAt = new Date()): void {
  root.querySelectorAll<HTMLElement>('[data-static-share-exported-at]').forEach(time => { time.textContent = exportedAt.toLocaleString(); time.setAttribute('datetime', exportedAt.toISOString()); });
  root.querySelectorAll('[data-static-share-exclude], .process-timeline__collapse').forEach(element => element.remove());
  const panels: Array<[string, string, string]> = [
    ['.changed-files-summary__toggle', '.changed-files-summary', '.changed-files-summary__content'],
    ['.process-timeline__trigger', '.process-timeline', '.process-timeline__panel'],
    ['.process-narrative__main', '[data-process-narrative]', '[data-process-narrative-content]'],
    ['.process-group__main', '.process-group', '.process-group__items'],
    ['.process-step__main', '.process-step', '.process-step__details'],
  ];
  root.querySelectorAll<HTMLButtonElement>('button[aria-expanded]').forEach((button, index) => {
    const user = button.closest('.user-message');
    const match = panels.find(([selector]) => button.matches(selector));
    const panel = user ? user.querySelector<HTMLElement>('.relative>div') : match ? button.closest(match[1])?.querySelector<HTMLElement>(match[2]) : null;
    if (!panel) return;
    panel.id = `static-share-panel-${index}`;
    button.setAttribute('aria-controls', panel.id);
    button.dataset.staticShareTarget = panel.id;
  });
}

export function downloadStaticSharePage(root: HTMLElement, title: string, script: string): void {
  const doc = root.ownerDocument;
  let css = '';
  for (const sheet of Array.from(doc.styleSheets)) {
    try { css += Array.from(sheet.cssRules).map((rule) => rule.cssText).join(''); } catch { /* 跨源样式不可读时跳过。 */ }
  }
  if (!css) throw new Error();
  const staticRoot = root.cloneNode(true) as HTMLElement;
  staticRoot.dataset.staticShareRoot = '';
  prepareStaticShareRoot(staticRoot);
  const html = buildStaticShareHtml(title, staticRoot.outerHTML, css, script, doc.documentElement.dataset.theme);
  const url = URL.createObjectURL(new Blob([html]));
  const link = doc.createElement('a');
  link.href = url; link.download = sanitizeStaticShareFilename(title);
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
