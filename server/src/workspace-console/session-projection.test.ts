import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSessionCard } from './session-projection.js';

test('projects engine, model, status and a bounded latest message', () => {
  const result = projectSessionCard({
    sessionId: 's1', title: '任务会话', projectPath: FIXED_WORKSPACE_PATH, updatedAt: 10,
    status: 'idle', url: '/?session=s1', engine: 'codex', modelId: 'gpt-5', latestMessage: 'a'.repeat(300),
  });
  assert.equal(result.engine, 'codex');
  assert.equal(result.modelId, 'gpt-5');
  assert.equal(result.latestMessage?.length, 240);
});
