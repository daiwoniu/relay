import path from 'node:path';
import fs from 'node:fs';
import { createScenarioResult } from './report.mjs';

export async function captureDocumentationScreenshots({ page, runtime, config }) {
  const results = [];
  for (const scene of [
    { id: 'readme-desktop', route: '/', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, mobile: false },
    { id: 'readme-mobile', route: '/', viewport: { width: 430, height: 932, deviceScaleFactor: 1 }, mobile: true },
    { id: 'readme-tools', route: '/tools', viewport: { width: 1280, height: 1600, deviceScaleFactor: 1 }, mobile: false },
  ]) {
    await page.setViewport(scene.viewport, { mobile: scene.mobile });
    await page.navigate(`${config.origin}${scene.route}`);
    await page.waitForStable({ timeoutMs: config.timeouts?.navigationMs });
    await page.prepareDocumentationScreenshot(scene.route);
    const relativePath = `screenshots/${scene.id}.png`;
    await page.captureScreenshot(path.join(runtime.runDir, relativePath));
    results.push(createScenarioResult({
      id: scene.id, status: 'passed', viewport: scene.viewport, screenshots: [relativePath],
      detail: '当前production真实界面；截图前隐藏账号、项目、会话标题、位置及个人用量，未创建演示业务数据',
    }));
  }
  await page.installDocumentationFixture();
  await page.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 1 }, { mobile: false });
  await page.navigate(`${config.origin}/?session=a1111111-1111-4111-8111-111111111111`);
  await page.waitForStable({ timeoutMs: config.timeouts?.navigationMs });
  for (const scene of ['assistant-list', 'assistant-time', 'assistant-category', 'preview-markdown', 'preview-markdown-source', 'preview-git', 'html-visual', 'html-source', 'engine-maintenance']) {
    // Close the preview before opening maintenance, through the real UI.
    let prepared;
    try { prepared = await page.prepareDocumentationScene(scene); }
    catch (error) {
      fs.writeFileSync(path.join(runtime.runDir, 'documentation-diagnostic.json'), JSON.stringify(await page.readDocumentationDiagnostics(), null, 2));
      await page.captureScreenshot(path.join(runtime.runDir, 'screenshots', 'documentation-failed.png'));
      throw error;
    }
    const relativePath = `screenshots/readme-${scene}.png`;
    await page.captureScreenshot(path.join(runtime.runDir, relativePath), { clip: prepared.clip });
    results.push(createScenarioResult({ id: `readme-${scene}`, status: 'passed',
      screenshots: [relativePath], detail: '当前 production 组件渲染浏览器内存示例数据；所有 API 写入和真实引擎连接均被隔离',
      evidence: { documentation: prepared.audit },
    }));
  }
  return results;
}

// Executed only inside the temporary acceptance browser. Original identities are
// never returned to Node or written to the report, and no application data is saved.
export async function redactDocumentationPage(route) {
  if (!['/', '/tools'].includes(route) || location.pathname !== route) throw new Error('截图页面不在允许范围');
  const read = async (url) => {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('截图脱敏资料读取失败');
    return response.json();
  };
  const [projects, sessions, auth] = await Promise.all([read('/api/projects'), read('/api/sessions'), read('/api/auth/me')]);
  if (!Array.isArray(projects) || !Array.isArray(sessions) || !auth?.user) throw new Error('截图脱敏资料结构无效');
  if (route === '/' && !document.querySelector('nav[aria-label="快捷导航"]')) throw new Error('首页未就绪');
  if (route === '/tools' && !document.querySelector('input[aria-label="搜索工具"]')) throw new Error('工具集未就绪');
  const replacements = new Map();
  const add = (value, replacement) => { if (typeof value === 'string' && value.trim()) replacements.set(value, replacement); };
  projects.forEach((project, index) => { add(project.name, `项目 ${index + 1}`); add(project.path, '[项目路径已隐藏]'); });
  sessions.forEach((session) => add(session.title, '[会话标题已隐藏]'));
  add(auth.user.displayName, '[账号已隐藏]');
  add(auth.user.username, '[账号已隐藏]');
  const entries = [...replacements].sort((a, b) => b[0].length - a[0].length);
  const scrub = (value) => entries.reduce((text, [original, replacement]) => original.length >= 3
    ? text.split(original).join(replacement)
    : text.trim() === original ? text.replace(original, replacement) : text, value);
  const apply = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName)) continue;
      const safe = scrub(node.nodeValue || '');
      if (safe !== node.nodeValue) node.nodeValue = safe;
    }
    for (const element of document.querySelectorAll('[title], [aria-label]')) {
      for (const name of ['title', 'aria-label']) {
        const value = element.getAttribute(name);
        if (value !== null && scrub(value) !== value) element.setAttribute(name, scrub(value));
      }
    }
    for (const element of document.querySelectorAll('.user-menu__trigger > :first-child, .user-menu__quota-pills, .user-menu__quota-warning')) {
      if (element.style.visibility !== 'hidden') element.style.visibility = 'hidden';
    }
    // The home weather line reveals the user's selected city. Keep its space so
    // the screenshot preserves the real layout rather than inventing a location.
    if (route === '/') for (const element of document.querySelectorAll('p')) {
      if (/[°℃]/u.test(element.textContent || '') && element.style.visibility !== 'hidden') element.style.visibility = 'hidden';
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const text = document.body.innerText;
  if (entries.some(([original]) => original.length >= 3 && text.includes(original))) {
    observer.disconnect();
    throw new Error('截图仍含未隐藏的个人标识');
  }
  return { ready: true, redacted: true };
}
