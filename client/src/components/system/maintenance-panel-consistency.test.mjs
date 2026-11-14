import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const service = fs.readFileSync(new URL('./ServiceMaintenanceDialog.tsx', import.meta.url), 'utf8');
const engine = fs.readFileSync(new URL('./EngineMaintenanceDialog.tsx', import.meta.url), 'utf8');
const trash = fs.readFileSync(new URL('../trash/TrashDialog.tsx', import.meta.url), 'utf8');
const css = readStyleSource();

test('服务与引擎维护共享运维面板宽度和表面层级', () => {
  assert.match(service, /import PanelShell/);
  assert.match(engine, /import PanelShell/);
  assert.match(service, /<PanelShell[\s\S]*?size="operations"/);
  assert.match(engine, /<PanelShell[\s\S]*?size="operations"/);
  assert.match(css, /\.panel-shell--operations \{ max-width: 48\.75rem/);
  assert.doesNotMatch(engine, /MaintenanceActionButton action=\{presentation\.primaryAction\}[\s\S]*lg:block/);
});

test('回收站使用统一内容管理面板宽度', () => {
  assert.match(trash, /import PanelShell/);
  assert.match(trash, /<PanelShell[\s\S]*?size="content"/);
  assert.match(css, /\.panel-shell--content \{ max-width: 51\.25rem/);
});
