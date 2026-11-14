import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./useRelayWebSocket.ts', import.meta.url), 'utf8');
const runtimePolicySource = await readFile(new URL('./runtime-snapshot-policy.ts', import.meta.url), 'utf8');

test('WebSocket Hook 使用重复 subscribe 获取权威快照', () => {
  assert.match(source, /const resyncSession = useCallback/);
  assert.match(source, /sendSubscribeCommand\(ws, sessionId, true\)/);
  assert.match(source, /PROCESSING_RESYNC_DELAYS_MS\.map/);
  assert.match(source, /return \{ send, cancel, cancelFollowup, resumeFollowups, respondToInteraction, reconnect, resyncSession \}/);
});

test('processing 空白快照保持已启动阶段', () => {
  assert.match(source, /runtimeCacheRef\.current\.applyRuntimeSync\(msg, sessionStatus\)/);
  assert.match(runtimePolicySource, /sessionStatus === 'processing'/);
  assert.match(runtimePolicySource, /hasVisibleProcessPresentation\(input\.processContent, input\.processSteps\)/);
});

test('最终回复落库后原子收敛消息和临时气泡但保留权威会话转换', () => {
  assert.match(
    source,
    /case 'message_saved':[\s\S]*?store\.applyMessageSaved\([\s\S]*?isAssistantTerminalMessage\(msg\.message\)[\s\S]*?!msg\.message\.isError[\s\S]*?isCurrentSession \|\| isTrackedStreamingSession[\s\S]*?\);/,
  );
  const messageCompleteBranch = source.slice(
    source.indexOf("case 'message_complete':"),
    source.indexOf("case 'token_usage':"),
  );
  assert.doesNotMatch(messageCompleteBranch, /finishStreaming|updateSessionStatus/);
});

test('运行中的 sync_state 不先清空流式气泡再重建', () => {
  const syncStateBranch = source.slice(
    source.indexOf("case 'sync_state':"),
    source.indexOf("case 'runtime_sync_state':"),
  );
  assert.match(syncStateBranch, /store\.applyRuntimeStreamingSnapshot\(projection\.snapshot\)/);
  const runtimeSnapshotBranch = syncStateBranch.slice(syncStateBranch.indexOf('const sessionStatus'));
  assert.doesNotMatch(runtimeSnapshotBranch, /store\.(?:startWaiting|startStreaming|appendDelta|addProcessStep|setProcessTimeline)\(/);
  assert.match(runtimeSnapshotBranch, /if \(!projection\.shouldPresent\)[\s\S]*?store\.finishStreaming\(\)[\s\S]*?store\.applyRuntimeStreamingSnapshot/);
});

test('模型偏好专用事件合并权威 revision 且发送命令可携带草稿偏好', () => {
  assert.match(source, /case 'engine_preferences_updated':[\s\S]*?store\.updateSession\(\{ id: msg\.sessionId, engine_preferences: msg\.preferences \}\)/);
  assert.match(source, /if \(enginePreferences\) payload\.enginePreferences = enginePreferences/);
});
