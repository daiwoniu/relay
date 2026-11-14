import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getMaintenanceOutputRows } from './maintenance-output-presentation.ts';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const source = fs.readFileSync(new URL('./MaintenanceOutput.tsx', import.meta.url), 'utf8');
const presentationSource = fs.readFileSync(new URL('./maintenance-output-presentation.ts', import.meta.url), 'utf8');
const styles = readStyleSource();
const snapshot = (lines) => ({ operationId: 'op-1', sequence: 1, lines, status: 'running', updatedAt: 1 });

test('最近命令输出始终投影固定两行并把单行放在底部', () => {
  assert.deepEqual(getMaintenanceOutputRows(null), ['等待命令输出…', null]);
  assert.deepEqual(getMaintenanceOutputRows(snapshot(['one'])), [null, 'one']);
  assert.deepEqual(getMaintenanceOutputRows(snapshot(['one', 'two', 'three'])), ['two', 'three']);
  assert.match(source, /maintenance-output__line--previous/);
  assert.match(source, /maintenance-output__line--current/);
});

test('命令原文不进入 live region且断联状态不清空已有输出', () => {
  assert.doesNotMatch(source, /aria-live/);
  assert.match(source, /输出暂时中断，等待恢复/);
  assert.match(presentationSource, /snapshot\?\.lines\.slice\(-2\)/);
  assert.match(source, /data-maintenance-output-disconnected/);
});

test('两行终端区域固定高度、截断长行并尊重 reduced-motion', () => {
  assert.match(styles, /\.maintenance-output__screen[\s\S]*grid-template-rows:\s*repeat\(2/);
  assert.match(styles, /\.maintenance-output__line[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.maintenance-output__line/);
});
