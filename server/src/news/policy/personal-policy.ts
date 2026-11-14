import { z } from 'zod';

const condition = z.string().regex(/^[a-z0-9_-]{1,80}$/).optional();
export const PersonalNewsRuleSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  kind: z.enum(['follow', 'mute']),
  category: condition, topic: condition, entity: condition, source: condition, eventType: condition,
}).strict().refine((rule) => Boolean(rule.category || rule.topic || rule.entity || rule.source || rule.eventType), '规则至少需要一个条件');
export const PersonalNewsPreferencesSchema = z.object({ rules: z.array(PersonalNewsRuleSchema).max(100) }).strict();
export type PersonalNewsRule = z.infer<typeof PersonalNewsRuleSchema>;
export type PersonalNewsPreferences = z.infer<typeof PersonalNewsPreferencesSchema>;
export const EMPTY_PERSONAL_NEWS_PREFERENCES: PersonalNewsPreferences = { rules: [] };

export interface PersonalNewsItem {
  categoryId: string; topicIds: string[]; entityIds: string[];
  eventTypeId: string | null; sourceId: string;
}

export function matchesPersonalRule(item: PersonalNewsItem, rule: PersonalNewsRule): boolean {
  return (!rule.category || item.categoryId === rule.category)
    && (!rule.topic || item.topicIds.includes(rule.topic))
    && (!rule.entity || item.entityIds.includes(rule.entity))
    && (!rule.source || item.sourceId === rule.source)
    && (!rule.eventType || item.eventTypeId === rule.eventType);
}

function reason(rule: PersonalNewsRule): string {
  const label: Record<string, string> = { category: '分类', topic: '话题', entity: '主体', source: '来源', eventType: '事件' };
  const details = (['category', 'topic', 'entity', 'source', 'eventType'] as const)
    .filter((key) => rule[key]).map((key) => `${label[key]} ${rule[key]}`).join(' + ');
  return `${rule.kind === 'mute' ? '屏蔽' : '关注'}：${details}`;
}

export function personalDecision(item: PersonalNewsItem, preferences: PersonalNewsPreferences): { muted: boolean; followed: boolean; reason: string | null } {
  const mute = preferences.rules.find((rule) => rule.kind === 'mute' && matchesPersonalRule(item, rule));
  if (mute) return { muted: true, followed: false, reason: reason(mute) };
  const follow = preferences.rules.find((rule) => rule.kind === 'follow' && matchesPersonalRule(item, rule));
  return { muted: false, followed: Boolean(follow), reason: follow ? reason(follow) : null };
}
