// Browser-only example data for documentation. No real session, file or engine
// operation is created. The production React bundle renders all controls.
export function installDocumentationFixture() {
  const nativeFetch = window.fetch.bind(window);
  const base = 'D:/relay-demo';
  const now = Date.UTC(2026, 10, 14, 2, 0);
  const sid = 'a1111111-1111-4111-8111-111111111111';
  const pid = 'b2222222-2222-4222-8222-222222222222';
  const mid = 'c3333333-3333-4333-8333-333333333333';
  const engines = [['codex', 'Codex'], ['codebuddy', 'CodeBuddy'], ['opencode', 'OpenCode'], ['zcode', 'ZCode']];
  const user = { id: 'documentation', username: 'relay-demo', displayName: 'Relay 演示', role: 'admin', avatarUpdatedAt: null, defaultProjectId: pid, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null, canCreateProject: true };
  const session = { id: sid, title: '界面演示 · 文档与预览', created_at: now, updated_at: now + 60000, pinned: 0, pinned_at: null, project_id: pid, engine: 'codex', codex_archived: false, can_fork: true, status: 'idle', engine_session_id: null, engine_preferences: { modelId: null, reasoningEffort: null, serviceTier: null, revision: 0 }, message_count: 2, context_compaction_count: 0 };
  const md = '# Relay 文档预览\n\n> 示例文件，仅用于展示界面。\n\n## 本次更新\n\n- [x] 补充助手处理过程三种视图\n- [x] 展示 Git 文件变更\n- [x] 展示 HTML 可视化与源码\n\n| 文件 | 用途 |\n| --- | --- |\n| README.md | 使用说明 |\n| preview.html | 页面预览 |\n\n```bash\ngit diff -- README.md\n```\n';
  const html = '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <title>Relay · 预览示例</title>\n  <style>\n    body{margin:0;padding:40px 28px;background:#f5f7fb;color:#203049;font:16px/1.7 system-ui,sans-serif}\n    .tag{color:#5675c9;font-size:12px;letter-spacing:3px}\n    h1{font-size:32px;line-height:1.2;margin:18px 0}\n    p{color:#68768c} .card{background:white;border:1px solid #e1e6f0;border-radius:16px;padding:22px;margin-top:20px}\n    .row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #eef0f5}\n    strong{color:#4f6fc0} .foot{font-size:12px;margin-top:28px}\n  </style>\n</head>\n<body>\n  <div class="tag">RELAY / WORKSPACE</div>\n  <h1>把想法，变成看得见的成果。</h1>\n  <p>在对话中完成修改，在右侧即时查看文档、源码与页面。</p>\n  <div class="card">\n    <div class="row"><span>文档说明</span><strong>已更新</strong></div>\n    <div class="row"><span>Git 变更</span><strong>可核对</strong></div>\n    <div class="row"><span>HTML 预览</span><strong>可视化 / 源码</strong></div>\n  </div>\n  <p class="foot">演示文件 · 无外部资源 · 无脚本</p>\n</body>\n</html>';
  const diff = 'diff --git a/README.md b/README.md\nindex 1234567..7654321 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,6 +1,11 @@\n # Relay 文档预览\n \n-仅提供基础使用说明。\n+> 示例文件，仅用于展示界面。\n \n-## 快速开始\n+## 本次更新\n+\n+- [x] 补充助手处理过程三种视图\n+- [x] 展示 Git 文件变更\n+- [x] 展示 HTML 可视化与源码\n+\n+文档和源码可以在右侧打开多个标签。\n';
  const items = [
    ['read-rules', 'commandExecution', { command: 'cat AGENTS.md', cwd: base, output: '已读取项目规则。', exitCode: 0 }],
    ['read-doc', 'commandExecution', { command: 'cat README.md', cwd: base, output: md, exitCode: 0 }],
    ['update-doc', 'fileChange', { path: `${base}/README.md`, kind: 'update', diff }],
    ['write-html', 'fileChange', { path: `${base}/preview.html`, kind: 'add' }],
    ['verify', 'commandExecution', { command: 'npm run validate:ai-docs', cwd: base, output: '文档链接、命令与索引检查通过。', exitCode: 0 }],
  ].map(([id, type, details], index) => ({ id, type, status: 'completed', details: { ...details, firstObservedAt: now + index * 8000, completedAt: now + index * 8000 + 3000 } }));
  const content = '### 文档与预览已准备好\n\n已补齐使用说明和示例页面，文档检查通过。\n\n- **README.md**：更新内容和检查清单\n- **preview.html**：可直接在右侧查看页面效果\n\n[打开 README.md](D:/relay-demo/README.md) · [打开 preview.html](D:/relay-demo/preview.html)\n\n> 这是截图专用示例数据，不代表真实项目或引擎执行记录。';
  const common = { session_id: sid, turn_id: 'demo-turn', phase: null, duration: null, stopped: false };
  const messages = [
    { ...common, id: 'd4444444-4444-4444-8444-444444444444', role: 'user', content: '请更新使用说明，并准备一个可以预览的 HTML 页面。', created_at: now, hasDetails: false },
    { ...common, id: mid, role: 'assistant', content, created_at: now + 60000, duration: 45000, outcome: 'completed', items, processContent: '先核对规则与现有文档，再更新文件，最后检查文档链接。', processTimeline: [{ type: 'narrative', itemId: 'narrative-1', content: '先核对规则与现有文档，再更新文件，最后检查文档链接。', firstObservedAt: now + 1000 }, ...items.map(item => ({ type: 'operation', itemId: item.id }))], hasDetails: true, processItemCount: items.length, processNarrativeCount: 1, changedFileCount: 2, changedFiles: [{ path: `${base}/README.md`, kind: 'update' }, { path: `${base}/preview.html`, kind: 'add' }] },
  ];
  const maintenance = engines.map(([engineId, label]) => ({ engineId, label, installedVersion: '1.0.0', runningVersion: engineId === 'codex' ? '1.0.0' : null, latestVersion: '1.0.0', updateAvailable: false, latestCheckStatus: 'success', latestCheckedAt: now, installSource: engineId === 'zcode' ? 'desktop' : 'official_npm_global', activeTaskCount: 0, activeInstanceCount: 0, instanceVersions: [], readiness: 'ready', readinessCheckedAt: now, availabilityStage: 'ready', recommendedAction: null, actions: [{ action: 'recheck', label: '重新检测', enabled: true }, ...(engineId === 'codex' ? [{ action: 'restart', label: '重启引擎', enabled: true }] : [])], statusMessage: '文档截图示例状态；未执行维护操作。' }));
  const audit = { mode: 'browser-memory-example', blockedWrites: 0, unknownReads: [], errors: [] };
  window.addEventListener('error', event => audit.errors.push(String(event.message).slice(0, 400)));
  window.addEventListener('unhandledrejection', event => audit.errors.push(String(event.reason).slice(0, 400)));
  const nativeError = console.error.bind(console);
  console.error = (...args) => { audit.errors.push(args.map(value => value instanceof Error ? value.message : typeof value === 'string' ? value : '').join(' ').slice(0, 500)); nativeError(...args); };
  window.__relayDocumentation = { audit, sid };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
    if (url.origin !== location.origin) throw new Error('Documentation fixture blocks external requests');
    const method = (init?.method || input?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') { audit.blockedWrites++; return json({ error: 'Documentation is read-only' }, 403); }
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    const p = url.pathname;
    if (p === '/api/auth/me') return json({ user });
    if (p === '/api/system/codex-account') return json({ fetchedAt: now, status: 'ready', authMode: 'unknown', email: null, planType: null, rateLimits: [], credits: null, rateLimitResetCredits: null, usage: null, errorMessage: null });
    if (p === '/api/auth/notification-preferences') return json({ preferences: { desktopSystemEnabled: false, desktopSoundEnabled: false, desktopSessionEndSystemEnabled: false, desktopSessionEndSoundEnabled: false, mobileSystemEnabled: false, mobileSoundEnabled: false, mobileSessionEndSystemEnabled: false, mobileSessionEndSoundEnabled: false, approvalSound: 'default', sessionEndSound: 'default', desktopSoundVolume: 50, mobileSoundVolume: 50 } });
    if (p === '/api/projects') return json([{ id: pid, name: 'Relay 示例项目', path: base, created_at: now, updated_at: now, pinned: 0, pinned_at: null, is_system: 0, access_role: 'owner', owner: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, avatarUpdatedAt: null } }]);
    if (p === '/api/sessions') return json([session]);
    if (p === `/api/sessions/${sid}`) return json(session);
    if (p.endsWith('/message-page')) return json({ unchanged: false, page: { sessionId: sid, revision: 1, hasMore: false, nextCursor: null, messages } });
    if (p.endsWith('/details')) return json({ sessionId: sid, messageId: mid, items, processContent: messages[1].processContent, processTimeline: messages[1].processTimeline, changedFiles: messages[1].changedFiles });
    if (p.endsWith('/messages')) return json(messages);
    if (p === '/api/filesystem/read') { const isHtml = url.searchParams.get('path')?.endsWith('.html'); return json({ type: 'text', content: isHtml ? html : md, language: isHtml ? 'html' : 'markdown', size: isHtml ? html.length : md.length }); }
    if (p === '/api/filesystem/metadata') return json({ path: url.searchParams.get('path'), size: 1024, createdAt: now, modifiedAt: now });
    if (p === '/api/filesystem/git-diff') return json({ changed: true, diff });
    if (p === '/api/system/engine-maintenance') return json({ engines: maintenance });
    if (p === '/api/engine-concurrency') return json(engines.map(([engineId, label]) => ({ resourceKey: engineId, engineId, label, maxActiveTurns: 3, activeTurns: 0, queuedTurns: 0, cooldownUntil: null, probeInProgress: false, windows: [5, 15, 60].map(windowMinutes => ({ windowMinutes, startAcceptedCount: 0, overloadCount: 0, requestRetryCount: 0, completionRetryCount: 0, cooldownCount: 0 })) })));
    if (p === '/api/system/engines') return json({ engines: engines.map(([id, label]) => ({ id, label, ideInstalled: true, cliInstalled: true, processReady: true, protocolReady: true, available: true, availabilityStage: 'ready', code: 'ready', message: '示例状态', version: '1.0.0', capabilities: { conversations: true, streaming: true, processItems: true, cancellation: true, interactions: true, tokenUsage: true, archive: false } })) });
    if (p.endsWith('/models')) return json({ engineId: 'codex', models: [], defaultModelId: null });
    if (p === '/api/sidebar-order') return json({ orders: [] });
    if (p === '/api/auth/theme-settings') {
      const profile = { backgroundKind: 'none', backgroundValue: null, blur: 0, fit: 'cover', position: 'center', overlayColor: '#000000', overlayOpacity: 0, panelOpacity: 1, glassBlur: 0, borderStrength: 0.55 };
      return json({ settings: { version: 2, basePreference: 'light', colorStyle: 'neutral', textScale: 'standard', linkedProfiles: true, desktop: profile, mobile: profile, updatedAt: 0 } });
    }
    if (p.includes('approval-trust')) return json({ projectSetting: null, sessionSetting: null, effective: { trusted: false, source: 'manual', effectiveScope: null, expiresAt: null, sessionOverridesProject: false, diagnostic: null } });
    if (p === '/api/health') return json({ status: 'ok' });
    if (!audit.unknownReads.includes(p)) audit.unknownReads.push(p);
    return json({});
  };
  // No socket connection is made, including subscribe/read-marker writes.
  class DocumentationSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; bufferedAmount = 0; protocol = ''; extensions = ''; binaryType = 'blob';
    constructor(url) { super(); this.url = String(url); setTimeout(() => { this.readyState = 1; const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event); setTimeout(() => { const event = new MessageEvent('message', { data: JSON.stringify({ type: 'protocol_info', protocolVersion: 35 }) }); this.dispatchEvent(event); this.onmessage?.(event); }, 10); }, 20); }
    send() {}
    close() { this.readyState = 3; const event = new CloseEvent('close', { code: 1000, wasClean: true }); this.dispatchEvent(event); this.onclose?.(event); }
  }
  window.WebSocket = DocumentationSocket;
  navigator.sendBeacon = () => false;
  // Diagnostic clients use XHR/EventSource; block those transport paths too.
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { if (String(url).includes('/api/')) throw new Error('Documentation XHR blocked'); return open.call(this, method, url, ...rest); };
  window.EventSource = class extends EventTarget { close() {} };
}

export async function prepareDocumentationScene(scene) {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn) => { for (let i = 0; i < 60; i++) { const value = fn(); if (value) return value; await sleep(100); } throw new Error('Documentation control unavailable'); };
  const clickText = async (selector, text) => { const button = await until(() => [...document.querySelectorAll(selector)].find(el => el.textContent.trim() === text)); button.click(); await sleep(250); return button; };
  if (!window.__relayDocumentation) throw new Error('Missing documentation fixture');
  if (scene.startsWith('assistant-')) {
    const trigger = await until(() => document.querySelector('.process-timeline__trigger'));
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    const label = { 'assistant-list': '普通列表', 'assistant-time': '时间流', 'assistant-category': '分类流' }[scene];
    await clickText('.process-view-switch button', label);
    if (scene === 'assistant-list') {
      for (const button of document.querySelectorAll('.process-group__main[aria-expanded="false"]')) button.click();
    }
    if (scene === 'assistant-category') {
      for (const button of document.querySelectorAll('.flow-branch__heading[aria-expanded="false"]')) button.click();
    }
    trigger.scrollIntoView({ block: 'start' });
  } else if (scene === 'engine-maintenance') {
    document.querySelector('button[aria-label="关闭预览面板"]')?.click();
    (await until(() => document.querySelector('.user-menu__trigger'))).click();
    const entry = await until(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('引擎维护')));
    entry.click();
    await until(() => document.querySelector('[aria-label="引擎列表"] button'));
    for (const el of document.querySelectorAll('details')) if (el.textContent.includes('版本与安装详情') || el.textContent.includes('运行诊断')) el.open = true;
  } else {
    const trigger = document.querySelector('.process-timeline__trigger[aria-expanded="true"]');
    trigger?.click();
    const html = scene.startsWith('html-');
    const path = `D:/relay-demo/${html ? 'preview.html' : 'README.md'}`;
    const link = await until(() => [...document.querySelectorAll('a,button,span[role="button"]')].find(el => el.getAttribute('href') === path || (el.textContent.trim() === `打开 ${html ? 'preview.html' : 'README.md'}` && el.getAttribute('role') === 'button')));
    link.click();
    await until(() => document.querySelector('input[aria-label="文件路径"]'));
    const label = { 'preview-markdown': '预览', 'preview-markdown-source': '源码', 'preview-git': 'Git 变更', 'html-visual': '可视化', 'html-source': '源码' }[scene];
    if (!label) throw new Error('Unsupported documentation preview scene');
    await clickText('[aria-label="文件预览模式"] button, [aria-label="HTML 预览模式"] button', label);
    if (html && scene === 'html-visual') await until(() => document.querySelector('iframe[aria-label^="HTML 可视化："]'));
  }
  await sleep(700);
  await document.fonts.ready;
  const selector = scene.startsWith('assistant-') ? '.assistant-message' : scene === 'engine-maintenance' ? '.panel-shell' : '.workspace-preview-panel';
  const rect = document.querySelector(selector)?.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height || window.__relayDocumentation.audit.errors.length) throw new Error('Documentation region invalid');
  const margin = 16;
  const x = Math.max(0, Math.floor(rect.left - margin));
  const y = Math.max(0, Math.floor(rect.top - margin));
  const right = Math.min(innerWidth, Math.ceil(rect.right + margin));
  const bottom = Math.min(innerHeight - (scene.startsWith('assistant-') ? 110 : 0), Math.ceil(rect.bottom + margin), scene.startsWith('assistant-') || scene === 'engine-maintenance' ? innerHeight : 850);
  return { ready: true, exampleData: true, audit: window.__relayDocumentation.audit, clip: { x, y, width: right - x, height: bottom - y, scale: 1 } };
}
