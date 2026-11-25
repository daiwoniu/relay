import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScenarioResult } from './report.mjs';

// Installed on top of the documentation fixture. All mutations stay inside this browser document.
export function installFeishuApprovalFixture() {
  const nextFetch = window.fetch.bind(window);
  const endpoint = '/api/admin/feishu-im';
  const now = Date.now();
  const bot = { id: 'a1111111-1111-4111-8111-111111111111', name: '验收机器人', workspace: '示例项目', enabled: true,
    active: true, groups: [{ id: 'oc_sample', name: '示例私聊', chatType: 'p2p' }], connection: { state: 'connected' } };
  const conversation = { conversationId: 'private:ou_sample:0', chatId: 'oc_sample', chatType: 'p2p', senderName: '示例账号',
    text: '检查示例文件', receivedAt: now, sequence: 7, total: 1, relayStatus: 'awaiting_action' };
  const message = { ...conversation, messageId: 'om_sample', sender: 'ou_sample', category: null, state: null, reply: null, summary: null };
  const requests = [
    { id: 'sample-allow', title: '允许与拒绝', detail: '读取 D:/demo/' + 'long-path-'.repeat(48) + 'notes.txt', accept: true, decline: true },
    { id: 'sample-decline', title: '仅拒绝', detail: '写入示例文件', accept: false, decline: true },
    { id: 'sample-cancel', title: '仅取消', detail: '检查示例配置', accept: false, decline: false, cancel: true },
  ];
  const steps = requests.map(item => ({ id: item.id, type: 'interaction', status: 'in_progress',
    details: { interactionKind: 'command_approval', title: item.title, command: item.detail } }));
  const decisions = [];
  window.__relayFeishuApprovalFixture = { decisions };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (url.origin !== location.origin || !url.pathname.startsWith(endpoint)) return nextFetch(input, init);
    if (url.pathname === endpoint + '/approvals' && method === 'POST') {
      const result = JSON.parse(init?.body ?? '{}');
      const index = requests.findIndex(item => item.id === result.id && item[result.action] === true);
      if (result.sequence !== 7 || result.bot !== bot.id || index < 0) return json({ error: '无效的验收交互' }, 409);
      decisions.push({ id: result.id, action: result.action });
      requests.splice(index, 1);
      const step = steps.find(item => item.id === result.id);
      step.status = 'completed';
      step.details.resolvedAction = result.action;
      return json({ requests: [] });
    }
    if (method !== 'GET') return json({ error: '验收请求未启用' }, 403);
    if (url.pathname === endpoint + '/approvals') return json({ requests });
    if (url.pathname === endpoint + '/execution') return json({ execution: { steps,
      processTimeline: steps.map(item => ({ type: 'operation', itemId: item.id })) } });
    const listing = url.searchParams.has('conversations');
    return json({ bots: [bot], selected: bot.id, data: { messages: listing ? [] : [message], conversations: [conversation], next: null,
      notices: [], matters: [], tally: { received: 1, pending: 1, failed: 0, unknown: 0 }, byUser: [], byDay: [], byGroup: [], byCategory: [] } });
  };
}

export async function inspectFeishuApprovalFixture(stage) {
  const wait = async find => {
    for (let i = 0; i < 100; i++) {
      const found = find();
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  };
  const buttons = label => [...document.querySelectorAll('.feishu-detail button')].filter(button =>
    button.textContent.trim() === label && button.getBoundingClientRect().width > 0);
  if (stage === 'layout') {
    const overview = await wait(() => document.querySelector('.feishu-view-heading') && document.querySelector('.feishu-record-overview'));
    let folding = null;
    if (overview) {
      overview.querySelector('summary').click();
      const toolbar = overview.querySelector('.feishu-toolbar');
      const counts = overview.querySelector('.feishu-counts');
      const hidden = await wait(() => !overview.open && !toolbar.getBoundingClientRect().height && !counts.getBoundingClientRect().height) === true;
      const tab = label => [...document.querySelectorAll('.feishu-nav button')].find(button => button.textContent.trim() === label);
      tab('事项').click();
      const matterFolding = await wait(() => tab('事项').getAttribute('aria-current') === 'page'
        && document.querySelector('.feishu-record-overview:not([open])')) !== null;
      tab('消息').click();
      const restored = await wait(() => tab('消息').getAttribute('aria-current') === 'page'
        && document.querySelector('.feishu-record-overview:not([open])'));
      folding = { messagesHidden: hidden, mattersClosed: matterFolding, messagesRestored: Boolean(restored) };
      restored?.querySelector('summary').click();
    }
    const row = await wait(() => document.querySelector('.feishu-message-list .feishu-row'));
    row?.click();
    const groups = await wait(() => {
      const found = [...document.querySelectorAll('.feishu-detail .process-timeline details[data-interaction-id]')];
      return found.length === 3 ? found : null;
    });
    groups?.forEach(group => group.querySelector('summary').click());
    const review = await wait(() => buttons('查看待审核操作')[0]);
    review?.click();
    if (!await wait(() => buttons('允许本次')[0])) return { ready: false };
    const detail = document.querySelector('.feishu-detail');
    return { ready: true, allow: buttons('允许本次').length, decline: buttons('拒绝').length, cancel: buttons('取消请求').length, folding,
      overflow: detail.scrollWidth > detail.clientWidth + 1,
      inline: [...buttons('允许本次'), ...buttons('拒绝'), ...buttons('取消请求')].every(button => button.closest('details[data-interaction-id]')) };
  }
  buttons('允许本次')[0]?.click();
  if (!await wait(() => window.__relayFeishuApprovalFixture?.decisions.length === 1 && buttons('拒绝').length === 1)) return { decisions: [] };
  buttons('拒绝')[0]?.click();
  if (!await wait(() => window.__relayFeishuApprovalFixture?.decisions.length === 2 && buttons('拒绝').length === 0)) return { decisions: [] };
  buttons('取消请求')[0]?.click();
  await wait(() => window.__relayFeishuApprovalFixture?.decisions.length === 3 && buttons('取消请求').length === 0);
  return { decisions: window.__relayFeishuApprovalFixture?.decisions ?? [], remaining: buttons('拒绝').length + buttons('取消请求').length };
}

export async function runFeishuApprovalScenarios({ page, runtime, config, built = false }) {
  if (built) {
    const root = fileURLToPath(new URL('../../../client/', import.meta.url));
    const { preview } = await import(new URL('../../../client/node_modules/vite/dist/node/index.js', import.meta.url).href);
    const previewServer = await preview({ root, configFile: false, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
    try {
      return await runScenarios({ page, runtime, config, origin: `http://127.0.0.1:${previewServer.httpServer.address().port}`, built });
    } finally {
      previewServer.httpServer.closeAllConnections();
      await new Promise(resolve => previewServer.httpServer.close(resolve));
    }
  }
  return runScenarios({ page, runtime, config, origin: config.origin, built });
}

async function runScenarios({ page, runtime, config, origin, built }) {
  await page.installFeishuApprovalFixture();
  const results = [];
  for (const [id, viewport] of [['desktop', config.desktopViewport], ['mobile', config.mobileViewport]]) {
    await page.setViewport(viewport, { mobile: id === 'mobile' });
    await page.navigate(`${origin}/admin/feishu-bots?view=messages`);
    const layout = await page.inspectFeishuApprovalFixture('layout');
    const screenshots = [];
    if (layout.ready) {
      const file = `screenshots/feishu-approval-${id}.png`;
      await page.captureScreenshot(path.join(runtime.runDir, file));
      screenshots.push(file);
    }
    const interaction = layout.ready ? await page.inspectFeishuApprovalFixture('decisions') : {};
    const valid = layout.allow === 1 && layout.decline === 2 && layout.cancel === 1 && interaction.remaining === 0
      && (!built || layout.inline && layout.folding && Object.values(layout.folding).every(Boolean))
      && JSON.stringify(interaction.decisions) === JSON.stringify([{ id: 'sample-allow', action: 'accept' }, { id: 'sample-decline', action: 'decline' }, { id: 'sample-cancel', action: 'cancel' }]);
    results.push(createScenarioResult({ id: `feishu-approval-${id}`, status: valid && !layout.overflow ? 'passed' : 'failed',
      detail: valid && !layout.overflow ? '待审核按钮与模拟提交通过，无横向溢出' : '待审核界面或模拟提交不符合预期',
      viewport, screenshots, snapshot: { layout, interaction } }));
  }
  return results;
}
