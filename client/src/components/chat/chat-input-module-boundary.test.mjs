import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('ChatInput delegates presentation-only regions to focused components', async () => {
  const source = await read('./ChatInput.tsx');

  assert.match(source, /import ChatInputMetadataBar,[^\n]+from '\.\/ChatInputMetadataBar';/);
  assert.match(source, /import ChatInputAddContentControl from '\.\/ChatInputAddContentControl';/);
  assert.match(source, /import ChatInputSubmitControl from '\.\/ChatInputSubmitControl';/);
  assert.match(source, /import ChatInputDialogs from '\.\/ChatInputDialogs';/);
});

test('ChatInput keeps business orchestration and stays within the facade budget', async () => {
  const source = await read('./ChatInput.tsx');

  assert.match(source, /const handleSubmit = /);
  assert.match(source, /const handleSelectedUploadFiles = /);
  assert.match(source, /const requestInputFocus = useCallback/);
  assert.ok(source.trimEnd().split(/\r?\n/).length <= 1110, 'ChatInput.tsx should stay at or below 1,110 lines');
});

test('extracted presentation components do not own stores or business APIs', async () => {
  const sources = await Promise.all([
    read('./ChatInputMetadataBar.tsx'),
    read('./ChatInputAddContentControl.tsx'),
    read('./ChatInputSubmitControl.tsx'),
    read('./ChatInputDialogs.tsx'),
    read('./ModelSettingsControl.tsx'),
    read('./ModelSettingsPanel.tsx'),
  ]);

  for (const source of sources) {
    assert.doesNotMatch(source, /useChatStore/);
    assert.doesNotMatch(source, /\.\.\/\.\.\/api\//);
  }
});
