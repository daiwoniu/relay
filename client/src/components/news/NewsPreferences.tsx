import Tooltip from '../ui/Tooltip';
import FailureNotice from '../ui/FailureNotice';
import { useState, type FormEvent } from 'react';
import type { NewsPersonalPreferencesDto, NewsPersonalRuleDto } from '../../generated/relay-contracts';
import type { NewsRuleMatchStats } from '../../api/news';
import '../../styles/news-preferences.css';

const FIELDS = [['category', '分类'], ['topic', '话题'], ['entity', '主体'], ['source', '来源'], ['eventType', '事件']] as const;
const fieldLabel = Object.fromEntries(FIELDS) as Record<string, string>;
type NewsRuleField = (typeof FIELDS)[number][0];
export type NewsRuleOptions = Record<NewsRuleField, Array<{ value: string; label: string }>>;

export default function NewsPreferences({ preferences, options, matchStats, busy, onSave, onClose }: {
  preferences: NewsPersonalPreferencesDto;
  options: NewsRuleOptions;
  matchStats: NewsRuleMatchStats | null;
  busy: boolean;
  onSave: (next: NewsPersonalPreferencesDto) => Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'follow' | 'mute'>('follow');
  const [fields, setFields] = useState({ category: '', topic: '', entity: '', source: '', eventType: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const labelFor = (key: NewsRuleField, value: string) => options[key].find((option) => option.value === value)?.label ?? value;
  const add = (event: FormEvent) => {
    event.preventDefault();
    const conditions = Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim().toLowerCase()]));
    if (!Object.keys(conditions).length) { setError('至少填写一个条件'); return; }
    const rule = { id: editingId ?? crypto.randomUUID(), kind, ...conditions } as NewsPersonalRuleDto;
    setError('');
    void onSave({ rules: editingId ? preferences.rules.map((existing) => existing.id === editingId ? rule : existing) : [...preferences.rules, rule] });
    setEditingId(null);
    setFields({ category: '', topic: '', entity: '', source: '', eventType: '' });
  };
  return <div className="news-preferences-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="news-preferences-panel" role="dialog" aria-modal="true" aria-labelledby="news-preferences-title">
      <div className="news-preferences-head"><div><h2 id="news-preferences-title">我的关注与屏蔽</h2><p>规则只影响你的资讯流。</p></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
      <div className="news-preferences-rules">
        {preferences.rules.length ? preferences.rules.map((rule) => <div className="news-preferences-rule" key={rule.id}>
          <span className={rule.kind === 'follow' ? 'follow' : 'mute'}>{rule.kind === 'follow' ? '关注' : '屏蔽'}</span>
          <span>{FIELDS.filter(([key]) => rule[key]).map(([key]) => `${fieldLabel[key]} ${labelFor(key, rule[key]!)}`).join(' + ')}</span>
          <Tooltip content="最近 48 小时匹配的事件数" asChild><span>{matchStats ? `${matchStats.truncated ? '至少 ' : ''}${matchStats.counts[rule.id] ?? 0} 条` : '统计中'}</span></Tooltip>
          <button type="button" disabled={busy} onClick={() => { setEditingId(rule.id); setKind(rule.kind); setFields({ category: rule.category ?? '', topic: rule.topic ?? '', entity: rule.entity ?? '', source: rule.source ?? '', eventType: rule.eventType ?? '' }); setError(''); }}>编辑</button>
          <button type="button" disabled={busy} onClick={() => void onSave({ rules: preferences.rules.filter((entry) => entry.id !== rule.id) })}>移除</button>
        </div>) : <p className="news-preferences-empty">还没有规则。添加一条关注后，“我的关注”才会出现内容。</p>}
      </div>
      <form onSubmit={add} className="news-preferences-form">
        <div className="news-preferences-form-head"><h3>{editingId ? '编辑规则' : '添加规则'}</h3><label>操作<select value={kind} onChange={(event) => setKind(event.target.value as 'follow' | 'mute')}><option value="follow">关注</option><option value="mute">屏蔽</option></select></label></div>
        <p>选择至少一个条件；同一条规则选多个条件时，需要同时满足。</p>
        <div className="news-preferences-grid">{FIELDS.map(([key, label]) => {
          const value = fields[key];
          return <label key={key}>{label}<select value={value} onChange={(event) => setFields((previous) => ({ ...previous, [key]: event.target.value }))}>
            <option value="">不限</option>
            {value && !options[key].some((option) => option.value === value) && <option value={value}>原规则：{value}</option>}
            {options[key].map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select></label>;
        })}</div>
        {error && <p className="news-preferences-error" role="alert"><FailureNotice error={error} /></p>}
        <button type="submit" disabled={busy || (!editingId && preferences.rules.length >= 100)}>{editingId ? '保存修改' : '添加规则'}</button>
        {editingId && <button type="button" disabled={busy} onClick={() => { setEditingId(null); setFields({ category: '', topic: '', entity: '', source: '', eventType: '' }); }}>取消编辑</button>}
      </form>
    </section>
  </div>;
}
