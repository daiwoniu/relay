import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('composer 使用统一工作台层级且不改变现有入口顺序', async () => {
  const source = await read('./ChatInput.tsx');

  assert.match(source, /className="composer-shell/);
  assert.match(source, /className=\{`composer-surface/);
  assert.ok(source.indexOf('<ChatInputMetadataBar') < source.indexOf('<AttachmentDraftList'));
  assert.ok(source.indexOf('<ChatInputAddContentControl') < source.indexOf('<ChatInputSubmitControl'));
  assert.match(source, /focus-within/);
});

test('项目、引擎和模型入口共享 compact trigger 展示契约', async () => {
  const [metadata, engine, model, styles] = await Promise.all([
    read('./ChatInputMetadataBar.tsx'),
    read('./EngineSelector.tsx'),
    read('./ModelSettingsControl.tsx'),
    read('../../styles/message-ui.css'),
  ]);

  assert.match(metadata, /composer-compact-trigger/);
  assert.match(engine, /composer-compact-trigger/);
  assert.match(model, /composer-compact-trigger/);
  assert.match(styles, /\.composer-compact-trigger\s*\{/);
  assert.match(styles, /\.composer-compact-trigger\[aria-expanded="true"\]/);
  assert.match(styles, /\.composer-compact-trigger:focus-visible/);
});

test('composer 样式使用主题语义变量并为移动触控保留安全命中区', async () => {
  const styles = await read('../../styles/message-ui.css');

  assert.match(styles, /\.composer-shell\s*\{/);
  assert.match(styles, /\.composer-surface\s*\{/);
  assert.match(styles, /var\(--color-overlay-border\)/);
  assert.match(styles, /@media \(max-width: 639px\)/);
  assert.match(styles, /min-height:\s*44px/);
});

test('输入框上方操作区使用紧凑上下间距', async () => {
  const [input, metadata] = await Promise.all([
    read('./ChatInput.tsx'),
    read('./ChatInputMetadataBar.tsx'),
  ]);

  assert.match(input, /mx-auto px-4 pt-1 pb-0/);
  assert.match(metadata, /className="composer-metadata-bar"/);
  assert.match(await read('../../styles/message-ui.css'), /\.composer-metadata-bar \{[^\n]*min-height: 18px;[^\n]*margin-bottom: \.25rem;/);
});

test('输入框左侧留白属于输入命中区而不是便签按钮间隙', async () => {
  const source = await read('./ChatInput.tsx');

  assert.match(source, /<textarea[\s\S]*className="relative z-\[1\] -ml-3\.5 block w-\[calc\(100%\+0\.875rem\)\][\s\S]*pl-\[18px\]/);
  assert.match(source, /<div className="absolute right-1\.5 top-2 z-\[2\] h-8 w-8">[\s\S]*<IconActionButton/);
});
