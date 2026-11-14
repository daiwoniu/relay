import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('assistant messages receive only their persisted model snapshot', async () => {
  const [list, assistant] = await Promise.all([read('../chat/MessageList.tsx'), read('./AssistantMessage.tsx')]);
  assert.match(list, /modelInfo=\{msg\.modelInfo\}/);
  assert.doesNotMatch(list, /modelInfoBySession/);
  assert.match(assistant, /modelInfo\?: MessageModelInfoDto/);
  assert.match(assistant, /<MessageModelInfo/);
  assert.match(assistant, /message-meta__separator shrink-0[^>]*>·<\/span>/);
});

test('message model info exposes current and rerouted details without switching controls', async () => {
  const source = await read('./MessageModelInfo.tsx');
  assert.match(source, /modelInfo\.effective/);
  assert.match(source, /modelInfo\.requested/);
  assert.match(source, /本轮模型/);
  assert.doesNotMatch(source, /实际使用|本轮实际模型/);
  assert.match(source, /modelInfo\.rerouted && modelInfo\.requested/);
  assert.match(source, /已调整/);
  assert.match(source, /<HoverCard/);
  assert.match(source, /<DetailsDialog/);
  assert.match(source, /aria-label=\{ariaLabel\}/);
  assert.match(source, /min-w-0 truncate whitespace-nowrap/);
  assert.doesNotMatch(source, /onApply|模型设置|type="radio"/);
  assert.match(source, /reasoningEffortToChinese/);
  assert.doesNotMatch(source, /formatReasoningEffortLabel/);
});

test('message metadata is forced onto one clipped line', async () => {
  const css = await read('../../styles/message-ui.css');
  assert.match(css, /\.message-meta[\s\S]*?white-space:\s*nowrap/);
  assert.match(css, /\.message-meta[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.message-actions[\s\S]*?flex-shrink:\s*0/);
  assert.match(css, /\.message-meta--assistant \.message-model-info\s*\{\s*flex:\s*0 1 auto;/);
  assert.doesNotMatch(css, /\.message-meta--assistant \.message-actions\s*\{[\s\S]*?margin-left:\s*auto/);
  assert.match(css, /\.message-meta\s*\{[\s\S]*?gap:\s*0\.25rem;/);
});
