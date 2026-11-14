import assert from 'node:assert/strict';
import test from 'node:test';
import { getCodexVersionPresentation } from './codex-version-presentation.ts';

test('Codex 版本状态生成协调一致的简短文案', () => {
  assert.equal(getCodexVersionPresentation({
    currentVersion: null,
    latestVersion: null,
    updateAvailable: null,
    status: 'checking',
    checkedAt: null,
  }).label, 'Codex');

  assert.deepEqual(getCodexVersionPresentation({
    currentVersion: null,
    latestVersion: '0.43.0',
    updateAvailable: null,
    status: 'success',
    checkedAt: 1,
  }), {
    label: 'Codex 版本不可用',
    detail: '最新 v0.43.0',
    tone: 'error',
  });

  assert.deepEqual(getCodexVersionPresentation({
    currentVersion: '0.42.0',
    latestVersion: null,
    updateAvailable: null,
    status: 'checking',
    checkedAt: null,
  }), {
    label: 'Codex v0.42.0',
    detail: '正在检查最新版',
    tone: 'checking',
  });

  assert.equal(getCodexVersionPresentation({
    currentVersion: '0.42.0',
    latestVersion: '0.42.0',
    updateAvailable: false,
    status: 'success',
    checkedAt: 1,
  }).detail, '已是最新版');

  assert.equal(getCodexVersionPresentation({
    currentVersion: '0.42.0',
    latestVersion: '0.43.0',
    updateAvailable: true,
    status: 'success',
    checkedAt: 1,
  }).detail, '最新 v0.43.0');

  assert.equal(getCodexVersionPresentation({
    currentVersion: '0.42.0',
    latestVersion: null,
    updateAvailable: null,
    status: 'error',
    checkedAt: 1,
  }).detail, '检查失败，请稍后重试');
});
