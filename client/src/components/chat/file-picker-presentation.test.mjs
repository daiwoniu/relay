import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('目录与文件选择器共享任务型面板骨架', async () => {
  const [shell, directory, host] = await Promise.all([
    read('./FilePickerShell.tsx'),
    read('./DirectoryPicker.tsx'),
    read('./HostFilePicker.tsx'),
  ]);

  assert.match(shell, /file-picker-shell__header/);
  assert.match(shell, /file-picker-shell__body/);
  assert.match(shell, /file-picker-shell__footer/);
  assert.match(directory, /<FilePickerShell/);
  assert.match(host, /<FilePickerShell/);
  assert.doesNotMatch(directory, /import Modal/);
  assert.doesNotMatch(host, /import Modal/);
});

test('共享骨架保留返回、搜索、关闭、路径和底栏插槽', async () => {
  const [shell, styles] = await Promise.all([read('./FilePickerShell.tsx'), read('../../styles/message-ui.css')]);

  assert.match(shell, /onBack/);
  assert.match(shell, /headerActions/);
  assert.match(shell, /subtitle/);
  assert.match(shell, /footer/);
  assert.match(shell, /containerClassName="max-sm:items-end max-sm:p-0"/);
  assert.match(styles, /safe-area-inset-bottom/);
});

test('目录路径只在共享标题副文本显示一次', async () => {
  const directory = await read('./DirectoryPicker.tsx');

  assert.match(directory, /subtitle=\{currentPath \|\| '选择盘符'\}/);
  assert.doesNotMatch(directory, />当前路径</);
});

test('目录与文件浏览状态继续由各自业务组件负责', async () => {
  const [directory, host] = await Promise.all([
    read('./DirectoryPicker.tsx'),
    read('./HostFilePicker.tsx'),
  ]);

  assert.match(directory, /没有子目录/);
  assert.match(directory, /无法访问此目录/);
  assert.match(directory, /当前目录没有匹配项/);
  assert.match(host, /此目录为空/);
  assert.match(host, /无法访问此目录/);
  assert.match(host, /已选择 \{selected\.size\} 个，还可选择/);
});
