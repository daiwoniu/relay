import assert from 'node:assert/strict';
import test from 'node:test';
import { PersonalNewsPreferencesSchema, personalDecision } from './personal-policy.js';

const item = { categoryId: 'research', topicIds: ['agent', 'coding'], entityIds: ['openai'], eventTypeId: 'release', sourceId: 'openai-news' };

test('personal rules use AND inside a rule, OR across rules, and mute wins', () => {
  const preferences = PersonalNewsPreferencesSchema.parse({ rules: [
    { id: 'a', kind: 'follow', category: 'research', topic: 'agent' },
    { id: 'b', kind: 'follow', source: 'other-source' },
    { id: 'c', kind: 'mute', entity: 'openai' },
  ] });
  assert.deepEqual(personalDecision(item, preferences), { muted: true, followed: false, reason: '屏蔽：主体 openai' });
  const noMute = { rules: preferences.rules.slice(0, 2) };
  assert.equal(personalDecision(item, noMute).followed, true);
  assert.equal(personalDecision({ ...item, categoryId: 'industry' }, noMute).followed, false);
});
