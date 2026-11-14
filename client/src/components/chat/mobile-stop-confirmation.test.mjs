import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await Promise.all([
  'ChatInput.tsx',
  'ChatInputSubmitControl.tsx',
  'ChatInputDialogs.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');

test('移动端停止生成需要二次确认，桌面端保持直接停止', () => {
  assert.match(source, /import ConfirmDialog from '\.\.\/ui\/ConfirmDialog';/);
  assert.match(source, /const \[stopConfirmOpen, setStopConfirmOpen\] = useState\(false\)/);
  assert.match(source, /const handleStopRequest = \(\) => \{\s+if \(isMobile\) \{\s+setStopConfirmOpen\(true\);\s+return;\s+\}\s+handleStop\(\);\s+\}/);
  assert.match(source, /onStop=\{handleStopRequest\}/);
  assert.match(source, /onClick=\{onStop\}/);
  assert.match(source, /title=\{isAwaitingAction \? '停止等待？' : '停止生成？'\}/);
  assert.match(source, /tone="warning"/);
  assert.match(source, /description=\{isAwaitingAction \? '确定不再等待当前操作吗？' : '确定停止继续生成这条回复吗？'\}/);
  assert.match(source, /notice=\{\{[\s\S]*title: '已有内容不会丢失',[\s\S]*description: '已经生成的内容会保留。'/);
  assert.match(source, /confirmLabel=\{isAwaitingAction \? '停止等待' : '停止生成'\}/);
  assert.match(source, /onConfirmStop=\{confirmStop\}/);
  assert.match(source, /<ConfirmDialog[\s\S]*open=\{stopConfirmOpen\}[\s\S]*onConfirm=\{onConfirmStop\}/);
  assert.doesNotMatch(source, /停止等待并结束任务|停止当前任务|停止任务/);
});

test('任务状态或会话变化时关闭过期的停止确认', () => {
  assert.match(source, /stopClickedRef\.current = false;\s+setStopConfirmOpen\(false\);\s+\}, \[isStreaming, isStopping, sessionId\]\);/);
});
