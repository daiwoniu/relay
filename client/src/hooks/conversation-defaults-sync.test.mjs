import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./useRelayWebSocket.ts', import.meta.url), 'utf8');

test('账号的新对话默认配置通过 WebSocket 更新认证用户', () => {
  assert.match(source, /const \{ user, updateUser \} = useAuth\(\)/);
  assert.match(source, /msg\.type === 'conversation_defaults_updated'/);
  assert.match(source, /updateUser\(msg\.user\)/);
});
