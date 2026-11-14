import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [source, styles] = await Promise.all([
  readFile(new URL('./ProcessSteps.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../styles/message-ui.css', import.meta.url), 'utf8'),
]);

test('过程面板使用统一时间线、分组、过程项和详情语义', () => {
  assert.match(source, /process-timeline/);
  assert.match(source, /process-timeline__content/);
  assert.match(source, /process-group process-group--/);
  assert.match(source, /process-step process-step--/);
  assert.match(source, /process-step__main/);
  assert.match(source, /process-step__summary/);
  assert.match(source, /process-step__details/);
});

test('运行、成功、失败和停止状态同时具备文字与语义 class', () => {
  assert.match(source, /process-step-status--running/);
  assert.match(source, /process-step-status--failed/);
  assert.match(source, /process-step-status--success/);
  assert.match(source, /process-narrative--\$\{status\}/);
  assert.match(source, /process-group--\$\{state\.tone\}/);
});

test('时间线使用轻量轨道、统一 focus 与受控长输出滚动', () => {
  assert.match(styles, /\.process-timeline__content\s*\{[\s\S]*?border-inline-start:[^;]*var\(--color-border\)/);
  assert.doesNotMatch(styles, /\.process-timeline__content\s*\{[\s\S]*?var\(--color-border-strong\)/);
  assert.match(styles, /\.process-step\s*\{[\s\S]*?position:\s*relative;/);
  assert.match(styles, /\.process-step__main:focus-visible[\s\S]*?var\(--color-focus-ring\)/);
  assert.match(styles, /\.process-step__code,[\s\S]*?\.process-step__output\s*\{[\s\S]*?max-height:/);
  assert.match(styles, /\.process-step__code\s*\{[\s\S]*?font-family:/);
});

test('桌面过程区横纵间距收紧且移动端使用紧凑触控高度', () => {
  assert.match(styles, /\.process-timeline__panel\s*\{[\s\S]*?padding-inline:\s*\.5rem/);
  assert.match(styles, /\.process-timeline__content\s*\{[\s\S]*?margin-block:\s*\.1875rem;[\s\S]*?padding-inline-start:\s*\.375rem/);
  assert.match(styles, /\.process-narrative__main,[\s\S]*?\.process-group__main\s*\{[\s\S]*?padding:\s*\.25rem \.5rem/);
  assert.match(styles, /\.process-step\s*\{[\s\S]*?padding-block:\s*\.25rem/);
  assert.match(styles, /\.process-step__details\s*\{[\s\S]*?margin-block-start:\s*\.125rem;[\s\S]*?margin-inline-start:\s*\.75rem/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.process-step__main,[\s\S]*?min-height:\s*2\.5rem/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.process-narrative,[\s\S]*?margin-block:\s*\.0625rem/);
});

test('命令展开箭头左侧不再渲染会被裁切的时间线节点', () => {
  assert.doesNotMatch(styles, /\.process-step::before/);
  assert.match(source, /disclosure\.canExpand[\s\S]*?<svg width="9" height="9"/);
});

test('长过程底部收起操作跟随当前面板内边距', () => {
  assert.match(source, /process-timeline__collapse/);
  assert.doesNotMatch(source, /className="-mx-3[^\n]*w-\[calc\(100%\+1\.5rem\)\]/);
  assert.match(styles, /\.process-timeline__collapse\s*\{[\s\S]*?margin-inline:\s*-\.5rem;[\s\S]*?width:\s*calc\(100% \+ 1rem\)/);
});
