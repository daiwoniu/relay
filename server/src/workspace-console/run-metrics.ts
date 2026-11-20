export interface RunMetric {
  label: string;
  value: number;
  kind: 'total' | 'change' | 'condition';
}

export interface RunMetrics {
  source: 'progress' | 'summary' | 'status';
  items: RunMetric[];
}

const totals: Array<[string, string]> = [
  ['scanned', '已扫描'], ['scanned_rows', '已扫描'], ['processed', '已处理'], ['扫描行数', '已扫描'],
  ['planned_repair', '计划修复'], ['output_rows', '已导出'],
  ['probe_rows', '探查取得'], ['old_id_candidates', '旧 ID 候选'],
  ['source_checked', '源记录核查'], ['source_count', '源记录范围'], ['relation_count', '关联范围'],
];
const changes: Array<[string, string]> = [
  ['updated', '已更新'], ['updated_rows', '已更新'],
  ['inserted', '已插入'], ['inserted_rows', '已插入'],
  ['old_marked', '旧记录标记'], ['field_updated', '字段修正'], ['relation_amendments', '关联修订'], ['source_updated', '源记录更新'],
];
const conditions: Array<[string, string]> = [
  ...['非企业', '已重解析企业', '关联一致', '原ID为空或非正数', '排除删除去重状态', '重解析差异', '未匹配或歧义', '成立日期矛盾'].map((label): [string, string] => [label, label]),
  ['repair', '符合修复条件'], ['identity_mismatch', '身份信息不一致'],
  ['not_snapshot_eligible', '不符合历史快照条件'], ['url_id_mismatch', 'URL ID 不一致'],
  ['old_id_occupied', '旧 ID 已占用'], ['new_record_absent', '新记录不存在'],
  ['old_same_id_absent', '旧表同 ID 记录不存在'], ['reg_date_mismatch', '登记日期不一致'],
  ['missing_url_id', '缺少 URL ID'], ['duplicate_new_id_mapping', '新 ID 映射重复'],
  ['above_old_id_threshold', '超出旧 ID 范围'], ['missing_mapping', '缺少映射'],
  ['invalid_reg_date', '登记日期无效'],
];

function count(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function projectRunMetrics(raw: Record<string, unknown>): RunMetric[] {
  const result: RunMetric[] = [];
  const seen = new Set<string>();
  const add = (record: Record<string, unknown>, fields: Array<[string, string]>, kind: RunMetric['kind']) => {
    for (const [key, label] of fields) {
      if (seen.has(`${kind}:${label}`)) continue;
      const value = count(record, key);
      if (value === null) continue;
      result.push({ label, value, kind });
      seen.add(`${kind}:${label}`);
    }
  };
  add(raw, totals, 'total');
  add(raw, changes, 'change');
  const nested = raw.counts;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    // processed and 扫描行数 represent the same population in this adapter.
    if (!seen.has('total:已处理') && !seen.has('total:已扫描')) add(nested as Record<string, unknown>, [['扫描行数', '已扫描']], 'total');
    add(nested as Record<string, unknown>, conditions, 'condition');
  }
  add(raw, conditions, 'condition');
  return result;
}
