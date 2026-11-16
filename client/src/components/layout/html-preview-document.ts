const VISUALIZATION_CDN_ORIGINS = [
  'https://cdnjs.cloudflare.com',
  'https://esm.sh',
  'https://cdn.jsdelivr.net',
].join(' ');

const TRUSTED_VISUALIZATION_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${VISUALIZATION_CDN_ORIGINS}`,
  `style-src 'unsafe-inline' ${VISUALIZATION_CDN_ORIGINS}`,
  `img-src data: blob: ${VISUALIZATION_CDN_ORIGINS}`,
  `font-src data: ${VISUALIZATION_CDN_ORIGINS}`,
  `connect-src ${VISUALIZATION_CDN_ORIGINS}`,
  "media-src data: blob:",
  "worker-src blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
].join('; ');

export const HTML_PREVIEW_HEIGHT_MESSAGE = 'codex-inline-vis-height';
export const HTML_PREVIEW_ANCHOR_MESSAGE = 'codex-inline-vis-anchor';

interface SandboxedHtmlDocumentOptions {
  nonce?: string;
  allowUserScripts?: boolean;
  standalone?: boolean;
}

export type VisualizationThemeVariables = Record<string, string>;

const THEME_VARIABLE_SOURCES: Record<string, string> = {
  '--background': '--color-bg',
  '--foreground': '--color-text',
  '--card': '--color-surface',
  '--card-foreground': '--color-text',
  '--popover': '--color-overlay-surface',
  '--popover-foreground': '--color-text',
  '--primary': '--color-primary',
  '--primary-foreground': '--theme-on-primary',
  '--secondary': '--color-bg-secondary',
  '--secondary-foreground': '--color-text-secondary',
  '--muted': '--color-bg-tertiary',
  '--muted-foreground': '--color-text-tertiary',
  '--accent': '--color-link',
  '--accent-foreground': '--color-code-bg',
  '--destructive': '--color-status-danger',
  '--border': '--color-border',
  '--input': '--color-border',
  '--ring': '--color-focus-ring',
  '--viz-series-1': '--color-brand-mark',
  '--viz-series-2': '--color-status-success',
  '--viz-series-3': '--color-status-warning',
  '--viz-series-4': '--color-link',
  '--viz-series-5': '--color-status-danger',
  '--viz-series-6': '--color-text-secondary',
  '--font-size-base': '--theme-font-content',
  '--font-size-sm': '--theme-font-content-small',
  '--font-size-lg': '--theme-font-content-large',
};

export function buildVisualizationThemeVariables(getValue: (name: string) => string): VisualizationThemeVariables {
  const variables: VisualizationThemeVariables = {};
  for (const [target, source] of Object.entries(THEME_VARIABLE_SOURCES)) {
    const value = getValue(source).trim();
    if (value) variables[target] = value;
  }
  variables['--font-size-base'] ||= '14px';
  variables['--font-size-sm'] ||= '12px';
  variables['--font-size-lg'] ||= '16px';
  return variables;
}

function serializeThemeVariables(themeVariables: VisualizationThemeVariables): string {
  return Object.entries(themeVariables)
    .filter(([name, value]) => /^--[a-z0-9-]+$/i.test(name) && value.length <= 200 && !/[<>{};]/.test(value))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
}

export function createHtmlPreviewNonce(): string {
  const bytes = new Uint8Array(18);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizeNonce(nonce?: string): string {
  return nonce && /^[A-Za-z0-9_-]+$/.test(nonce) ? nonce : createHtmlPreviewNonce();
}

function buildPreviewCsp(nonce: string, allowUserScripts: boolean): string {
  if (allowUserScripts) return TRUSTED_VISUALIZATION_CSP;
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline' ${VISUALIZATION_CDN_ORIGINS}`,
    `img-src data: blob: ${VISUALIZATION_CDN_ORIGINS}`,
    `font-src data: ${VISUALIZATION_CDN_ORIGINS}`,
    "connect-src 'none'",
    "media-src data: blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
  ].join('; ');
}

function buildSecurityHead(
  themeVariables: VisualizationThemeVariables,
  nonce: string,
  allowUserScripts: boolean,
): string {
  const themeCss = serializeThemeVariables(themeVariables);
  const hostCss = `:root{${themeCss};color-scheme:light dark}html,body{margin:0;min-width:0;background:transparent;color:var(--foreground);font-size:var(--font-size-base);overflow-x:hidden}*{box-sizing:border-box}body{width:100%}`;
  const nonAnchorClick = allowUserScripts ? 'return' : 'event.preventDefault();return';
  const anchorBridge = `document.addEventListener('click',(event)=>{const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor)return;const href=anchor.getAttribute('href')||'';if(!href.startsWith('#')){${nonAnchorClick}}queueMicrotask(()=>{if(event.defaultPrevented)return;let fragment='';try{fragment=decodeURIComponent(href.slice(1))}catch{fragment=href.slice(1)}const target=fragment?(document.getElementById(fragment)||document.getElementsByName(fragment)[0]):document.body;if(!target)return;const top=Math.max(0,Math.ceil(target.getBoundingClientRect().top+window.scrollY));parent.postMessage({type:${JSON.stringify(HTML_PREVIEW_ANCHOR_MESSAGE)},top},'*')})},true);`;
  const bridge = `(()=>{const type=${JSON.stringify(HTML_PREVIEW_HEIGHT_MESSAGE)};let last=0;const measure=document.createElement('div');measure.id='relay-preview-measure';measure.setAttribute('aria-hidden','true');measure.style.cssText='clear:both;width:0;height:0;margin:0;padding:0;border:0';const start=()=>{const body=document.body;if(!body)return;if(!measure.isConnected)body.appendChild(measure);const report=()=>{let bottom=Math.max(body.offsetHeight,measure.offsetTop+measure.offsetHeight);for(const element of body.querySelectorAll('*')){if(element===measure)continue;const rect=element.getBoundingClientRect();if(Number.isFinite(rect.bottom))bottom=Math.max(bottom,rect.bottom+window.scrollY)}const height=Math.ceil(bottom);if(height>0&&height!==last){last=height;parent.postMessage({type,height},'*')}};const schedule=()=>requestAnimationFrame(report);const resize=new ResizeObserver(schedule);resize.observe(body);const mutations=new MutationObserver(schedule);mutations.observe(body,{subtree:true,childList:true,attributes:true,characterData:true});addEventListener('load',schedule,true);schedule()};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();${anchorBridge}})();`;
  return `<meta http-equiv="Content-Security-Policy" content="${buildPreviewCsp(nonce, allowUserScripts)}"><meta name="referrer" content="no-referrer"><style>${hostCss}</style><script nonce="${nonce}">${bridge}</script>`;
}

function removeDocumentNavigationMetadata(content: string): string {
  return content.replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(["'])?refresh\1?)[^>]*>/gi, '');
}

export function buildSandboxedHtmlDocument(
  content: string,
  themeVariables: VisualizationThemeVariables = {},
  options: SandboxedHtmlDocumentOptions = {},
): string {
  const nonce = normalizeNonce(options.nonce);
  const allowUserScripts = options.allowUserScripts === true;
  const sanitizedContent = removeDocumentNavigationMetadata(content);
  const securityHead = options.standalone
    ? `<meta http-equiv="Content-Security-Policy" content="${buildPreviewCsp(nonce, allowUserScripts)}"><meta name="referrer" content="no-referrer">`
    : buildSecurityHead(themeVariables, nonce, allowUserScripts);
  if (/<head(?:\s[^>]*)?>/i.test(sanitizedContent)) {
    return sanitizedContent.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${securityHead}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(sanitizedContent)) {
    return sanitizedContent.replace(/<html(?:\s[^>]*)?>/i, (html) => `${html}<head>${securityHead}</head>`);
  }
  return `<!doctype html><html><head>${securityHead}</head><body>${sanitizedContent}</body></html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Keep untrusted HTML in an opaque origin even when opened outside Relay.
// A viewport-sized frame preserves vh/vw, media queries and native scrolling.
export function buildStandaloneHtmlPreview(content: string, title: string): string {
  const document = buildSandboxedHtmlDocument(content, {}, { standalone: true, allowUserScripts: true });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtmlAttribute(title)}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe title="HTML 预览" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtmlAttribute(document)}"></iframe></body></html>`;
}
