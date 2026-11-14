import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildStaticShareHtml,
  readStaticShareScript,
  sanitizeStaticShareFilename,
  STATIC_SHARE_SCRIPT_HASH,
} from './static-share-export.ts';

const STATIC_SHARE_SCRIPT = fs.readFileSync(new URL('../../../public/static-share-script.js', import.meta.url), 'utf8');

const pageSource = fs.readFileSync(new URL('./PublicSharePage.tsx', import.meta.url), 'utf8');
const listSource = fs.readFileSync(new URL('./PublicShareMessageList.tsx', import.meta.url), 'utf8');
const userSource = fs.readFileSync(new URL('../messages/UserMessage.tsx', import.meta.url), 'utf8');
const assistantSource = fs.readFileSync(new URL('../messages/AssistantMessage.tsx', import.meta.url), 'utf8');
const processSource = fs.readFileSync(new URL('../messages/ProcessSteps.tsx', import.meta.url), 'utf8');
const changedFilesSource = fs.readFileSync(new URL('../messages/ChangedFilesSummary.tsx', import.meta.url), 'utf8');
const interactionSource = fs.readFileSync(new URL('../messages/InteractionPanel.tsx', import.meta.url), 'utf8');
const exporterSource = fs.readFileSync(new URL('./static-share-export.ts', import.meta.url), 'utf8');
const messageStyles = fs.readFileSync(new URL('../../styles/message-ui.css', import.meta.url), 'utf8');

test('静态分享文件名清理非法字符、尾部点空格与 Windows 保留名称', () => {
  assert.equal(sanitizeStaticShareFilename('  会话：A/B*?  '), '会话_A_B__.html');
  assert.equal(sanitizeStaticShareFilename('CON'), 'Relay_CON.html');
  assert.equal(sanitizeStaticShareFilename('...'), 'Relay 分享.html');
  assert.equal(sanitizeStaticShareFilename('a'.repeat(120)).length, 85);
});

test('静态分享文档内联样式、转义标题且只允许固定离线脚本', () => {
  const html = buildStaticShareHtml('测试 </title><script>alert(1)</script>', '<main data-static-share-root><h1>安全内容</h1></main>', '.message{color:red}', STATIC_SHARE_SCRIPT, 'dark');

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>\.message\{color:red\}[\s\S]*<\/style>/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.equal(STATIC_SHARE_SCRIPT_HASH, createHash('sha256').update(STATIC_SHARE_SCRIPT).digest('base64'));
  assert.match(html, /form-action 'none'/);
  assert.match(html, /<html lang=zh-CN data-theme="dark" data-static-share-document/);
  assert.match(html, /html\[data-static-share-document\]\{height:auto!important;min-height:100%;overflow-y:auto!important\}/);
  assert.match(html, /html\[data-static-share-document\] body\{height:auto!important;min-height:100%;overflow-y:visible!important\}/);
  assert.match(html, /\[data-static-share-root\]\{height:auto!important;min-height:100vh;overflow-y:visible!important\}/);
  assert.match(html, /<title>测试 (?:&lt;|&#60;)\/title(?:&gt;|&#62;)(?:&lt;|&#60;)script(?:&gt;|&#62;)alert\(1\)(?:&lt;|&#60;)\/script(?:&gt;|&#62;) · Relay 分享<\/title>/);
  assert.match(html, /<script>/);
  assert.doesNotMatch(STATIC_SHARE_SCRIPT, /fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|eval|Function/);
  assert.doesNotMatch(html, /\/api\/|type="module"/i);
});

test('公开分享页只在有效分享中接入离线下载入口与状态反馈', () => {
  assert.match(pageSource, /downloadStaticSharePage/);
  assert.match(pageSource, /data-static-share-exclude/);
  assert.match(pageSource, /state\.type === 'active'/);
  assert.match(pageSource, /下载离线 HTML/);
  assert.match(pageSource, /导出失败/);
  assert.match(pageSource, /fetch\('\/static-share-script\.js',/);
  assert.match(pageSource, /readStaticShareScript/);
  assert.match(pageSource, /integrity: `sha256-\$\{STATIC_SHARE_SCRIPT_HASH\}`/);
  assert.match(pageSource, /exportStatus === 'loading'/);
  assert.match(pageSource, /disabled=\{exportStatus === 'loading' \|\| exportStatus === 'preparing'\}/);
  assert.match(pageSource, /aria-busy=\{exportStatus === 'loading' \|\| exportStatus === 'preparing'\}/);
  assert.match(pageSource, /message-feedback message-feedback--error/);
  assert.doesNotMatch(pageSource, /window\.alert/);
});

test('公开分享加载状态和顶部主题入口复用统一反馈与图标操作', () => {
  assert.match(pageSource, /message-inline-feedback message-inline-feedback--share-loading/);
  assert.match(pageSource, /assistant-message__status-icon animate-spin/);
  assert.match(pageSource, /data-static-share-theme/);
  assert.match(pageSource, /<IconActionButton[\s\S]*?label=\{themeLabel\}/);
  assert.doesNotMatch(pageSource, /<button type="button" onClick=\{cycleTheme\}[^>]*border/);
});

test('切换分享链接会使尚未完成的旧导出结果失效', () => {
  assert.match(pageSource, /const exportRequestRef = useRef\(0\)/);
  assert.match(pageSource, /exportTokenRef\.current = token/);
  assert.match(pageSource, /exportRequestRef\.current \+= 1/);
  assert.match(pageSource, /requestId !== exportRequestRef\.current \|\| exportTokenRef\.current !== requestToken/);
});

test('分享错误反馈具备完整卡片骨架且顶部操作满足移动触控尺寸', () => {
  assert.match(messageStyles, /\.message-feedback\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:[\s\S]*?padding:/);
  assert.equal(pageSource.match(/className="h-10 w-10 sm:h-7 sm:w-7"/g)?.length, 3);
});

test('离线脚本响应必须成功、类型正确且内容匹配 CSP 哈希', async () => {
  const valid = new Response(STATIC_SHARE_SCRIPT, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
  assert.equal(await readStaticShareScript(valid), STATIC_SHARE_SCRIPT);
  assert.equal(await readStaticShareScript(
    new Response(STATIC_SHARE_SCRIPT, { headers: { 'Content-Type': 'text/javascript' } }),
    null,
  ), STATIC_SHARE_SCRIPT);

  await assert.rejects(
    readStaticShareScript(new Response(STATIC_SHARE_SCRIPT, { status: 404, headers: { 'Content-Type': 'text/javascript' } })),
    /离线脚本/,
  );
  await assert.rejects(
    readStaticShareScript(new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })),
    /离线脚本/,
  );
  await assert.rejects(
    readStaticShareScript(new Response('console.log(1)', { headers: { 'Content-Type': 'application/javascript' } })),
    /离线脚本/,
  );
});

test('导出预绘制态收集全部内容并标注离线默认折叠交互', () => {
  assert.match(pageSource, /useLayoutEffect/);
  assert.match(pageSource, /full={exporting}/);
  assert.match(listSource, /full/);
  assert.match(userSource, /full \|\| expanded \|\| searchTarget/);
  assert.match(assistantSource, /full={full}/);
  assert.match(processSource, /full \? false :/);
  assert.match(processSource, /full \|\|/);
  assert.match(processSource, /<InteractionPanel[^>]*full=\{full\}/);
  assert.match(interactionSource, /full\?: boolean/);
  assert.match(interactionSource, /full \|\| expanded/);
  assert.match(changedFilesSource, /full \|\| expanded/);
  assert.match(changedFilesSource, /full \? files :/);
  assert.match(userSource, /aria-expanded/);
  assert.match(processSource, /aria-expanded/);
  assert.match(changedFilesSource, /aria-expanded/);
  assert.match(STATIC_SHARE_SCRIPT, /aria-expanded/);
  assert.match(STATIC_SHARE_SCRIPT, /hidden/);
});

test('公开分享助手消息不显示无实际用途的更多操作入口', () => {
  assert.match(listSource, /<AssistantMessage[\s\S]*?readOnly/);
  assert.match(assistantSource, /if \(!readOnly && displayContent\)[\s\S]*?key: 'source'/);
  assert.match(assistantSource, /const showDirectCopy = Boolean\(displayContent\) && \(!mobile \|\| readOnly\)/);
});

test('离线页面保留宽屏与主题切换控件', () => {
  assert.match(pageSource, /data-static-share-theme/);
  assert.match(pageSource, /切换宽屏显示/);
  assert.match(STATIC_SHARE_SCRIPT, /dataset\.theme/);
  assert.match(STATIC_SHARE_SCRIPT, /static-share-theme/);
  assert.match(STATIC_SHARE_SCRIPT, /max-w-none/);
});

test('下载链接加入文档并延迟释放 object URL', () => {
  assert.match(exporterSource, /root\.cloneNode\(true\)/);
  assert.match(exporterSource, /staticRoot\.dataset\.staticShareRoot = ''/);
  assert.match(exporterSource, /doc\.body\.appendChild\(link\)/);
  assert.match(exporterSource, /link\.remove\(\)/);
  assert.match(exporterSource, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 1000\)/);
});

test('宽屏按钮根据当前布局切换方向图标', () => {
  assert.match(pageSource, /d=\{wideLayout \?/);
});
