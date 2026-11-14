import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../styles/style-source.test-helper.mjs';

const source = fs.readFileSync(new URL('../components/system/MaintenanceProgress.tsx', import.meta.url), 'utf8');
const styles = readStyleSource();

test('维护进度提供可访问的状态环、不定进度条和长耗时提示', () => {
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /output !== undefined && <MaintenanceOutput/);
  assert.match(source, /maintenance-progress__spinner/);
  assert.match(source, /maintenance-progress__bar/);
  assert.match(source, /耗时比平时更久，仍在等待操作完成/);
  assert.match(source, /slowAfterMs = 15_000/);
  assert.match(source, /slowMessage/);
});

test('维护进度动画尊重 reduced-motion', () => {
  assert.match(styles, /@keyframes maintenance-progress-slide/);
  assert.match(styles, /\.maintenance-progress__bar/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*\.maintenance-progress__spinner[\s\S]*\.maintenance-progress__bar/);
});
