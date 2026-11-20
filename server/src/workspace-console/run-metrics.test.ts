import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRunMetrics } from './run-metrics.js';

test('projects only recorded counters with separate planned and actual changes', () => {
  assert.deepEqual(projectRunMetrics({ scanned: 100000, planned_repair: 98694, updated: 0, inserted: 3,
    counts: { repair: 98694, identity_mismatch: 1043, not_snapshot_eligible: 165, url_id_mismatch: 78 },
    endpoint: 'private-host', limit: 100000 }), [
    { label: '已扫描', value: 100000, kind: 'total' },
    { label: '计划修复', value: 98694, kind: 'total' },
    { label: '已更新', value: 0, kind: 'change' },
    { label: '已插入', value: 3, kind: 'change' },
    { label: '符合修复条件', value: 98694, kind: 'condition' },
    { label: '身份信息不一致', value: 1043, kind: 'condition' },
    { label: '不符合历史快照条件', value: 165, kind: 'condition' },
    { label: 'URL ID 不一致', value: 78, kind: 'condition' },
  ]);
});

test('projects sample export counters and skips invalid values', () => {
  assert.deepEqual(projectRunMetrics({ scanned_rows: 200, output_rows: 150, missing_mapping: 10, invalid_reg_date: -1,
    buckets: { '2021': { output: 50 } }, updated: '12' }), [
    { label: '已扫描', value: 200, kind: 'total' },
    { label: '已导出', value: 150, kind: 'total' },
    { label: '缺少映射', value: 10, kind: 'condition' },
  ]);
});

test('projects real scan schema without duplicating processed and scanned counters', () => {
  assert.deepEqual(projectRunMetrics({ processed: 100000, counts: { 扫描行数: 100000, 重解析差异: 4, 成立日期矛盾: 44, 私有任意字段: 8 } }), [
    { label: '已处理', value: 100000, kind: 'total' },
    { label: '重解析差异', value: 4, kind: 'condition' },
    { label: '成立日期矛盾', value: 44, kind: 'condition' },
  ]);
});
