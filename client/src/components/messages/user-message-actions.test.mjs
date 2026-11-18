import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./UserMessage.tsx', import.meta.url), 'utf8');
const list = await readFile(new URL('../chat/MessageList.tsx', import.meta.url), 'utf8');

test('用户消息直接显示设备信息、复制和时间，不提供单条分享或更多菜单', () => {
  const device = source.indexOf('<MessageOriginInfo');
  const copy = source.indexOf('<Tooltip content={copied');
  const time = source.indexOf('<span className="shrink-0">{formatCompletionTime(createdAt)}</span>');
  assert.ok(device >= 0 && copy > device && time > copy);
  assert.doesNotMatch(source, /MessageActionsMenu|onShare|label: '分享'/);
  const userRender = list.match(/<UserMessage[\s\S]*?\/>/)?.[0] || '';
  assert.ok(userRender);
  assert.doesNotMatch(userRender, /onShare=/);
});

test('用户消息操作从右侧按设备信息、复制、时间连续排列并贴近气泡', async () => {
  const styles = await readFile(new URL('../../styles/message-ui.css', import.meta.url), 'utf8');
  assert.match(styles, /\.message-meta--user\s*\{[\s\S]*?margin-top:\s*0\.25rem;[\s\S]*?justify-content:\s*flex-end;/);
  assert.match(source, /<MessageOriginInfo[\s\S]*?<Tooltip content=\{copied[\s\S]*?<span className="shrink-0">\{formatCompletionTime\(createdAt\)\}<\/span>/);
});

test('会话级选择消息分享能力继续保留', () => {
  assert.match(list, /selectionMode=\{shareSelectionMode\}/);
  assert.match(list, /onToggleSelection=\{\(\) => onToggleShareSelection\?\.\(msg\.id\)\}/);
});
