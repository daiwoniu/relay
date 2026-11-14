import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { clearAuthenticatedLocalStorage } from './authenticated-storage.ts';

const authenticatedStateSource = await readFile(new URL('./authenticated-state.ts', import.meta.url), 'utf8');
const authContextSource = await readFile(new URL('./AuthContext.tsx', import.meta.url), 'utf8');

test('切换账号清理用户内容但保留设备级主题和布局设置', () => {
  const values = new Map([
    ['relay_chat_location', 'session-a'], ['relay.local-notes.v1', 'notes-a'],
    ['relay:chat-draft:session-a', 'draft-a'], ['relay.project-engine.v1:project-a', 'codex'],
    ['relay_pending_approval_hidden_v1:user-a', 'hidden'], ['relay:engine-maintenance:user-a:opencode', 'op-1'], ['relay_theme', 'dark'],
    ['relay.sidebar.width.v1', '300'],
  ]);
  const storage = {
    get length() { return values.size; }, key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
  };
  clearAuthenticatedLocalStorage(storage);
  assert.deepEqual([...values.keys()].sort(), ['relay.sidebar.width.v1', 'relay_theme']);
});

test('认证成功后的缓存归属确认与聊天候选恢复由统一生命周期负责', () => {
  assert.match(authenticatedStateSource, /export async function activateAuthenticatedClientState\(userId: string\)/);
  assert.match(
    authenticatedStateSource,
    /await activateMessageCacheUser\(userId\)\.catch\(\(\) => undefined\);\s+useChatStore\.getState\(\)\.restoreStoredChatCandidate\(\);/,
  );
  assert.match(authContextSource, /import \{ activateAuthenticatedClientState, resetAuthenticatedClientState \} from '\.\/authenticated-state';/);
  assert.equal(authContextSource.includes("import('../cache/message-cache')"), false);
  assert.equal(authContextSource.match(/await activateAuthenticatedClientState\(payload\.user\.id\);/g)?.length, 2);
});
