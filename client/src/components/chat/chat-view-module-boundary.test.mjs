import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('ChatView delegates deterministic page regions to the presentation module', async () => {
  const source = await read('./ChatView.tsx');

  for (const name of [
    'ChatViewHeaderRegion',
    'ChatViewMessageRegion',
    'ChatViewComposerRegion',
    'ChatViewDialogs',
  ]) {
    assert.match(source, new RegExp(`\\b${name}\\b`));
  }
  assert.match(source, /from '\.\/ChatViewPresentation';/);
});

test('ChatView keeps runtime orchestration and stays within the facade budget', async () => {
  const source = await read('./ChatView.tsx');

  assert.match(source, /const handleSend = async/);
  assert.match(source, /const requestLatestMessagesRefresh = useCallback/);
  assert.match(source, /const ensureMessageDetails = useCallback/);
  assert.match(source, /const navigateSearchMatch = useCallback/);
  assert.ok(source.trimEnd().split(/\r?\n/).length <= 1310, 'ChatView.tsx should stay at or below 1,310 lines');
});

test('ChatView presentation does not own stores, websocket, or APIs', async () => {
  const source = await read('./ChatViewPresentation.tsx');

  assert.doesNotMatch(source, /useChatStore|useSessionSearchStore|useRelayWebSocket/);
  assert.doesNotMatch(source, /\.\.\/\.\.\/api\//);
});
