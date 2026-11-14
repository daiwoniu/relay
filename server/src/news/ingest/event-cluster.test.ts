import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseEventId } from './event-cluster.js';
import type { NewsItemInput } from '../types.js';

function item(id: string, title: string, publishedAt: number): NewsItemInput {
  return { id, eventId: id, sourceId: 'source-a', url: `https://example.org/${id}`, title, description: null, publishedAt, firstFetchedAt: publishedAt, categoryId: 'industry', topicIds: [], entityIds: [], eventTypeId: 'release', language: 'en' };
}

test('跨月相似事件复用同一事件 ID，远期或不同主题不合并', () => {
  const jan = Date.parse('2026-01-31T23:00:00Z');
  const feb = Date.parse('2026-02-01T01:00:00Z');
  const previous = item('older', 'OpenAI releases new model Orion', jan);
  assert.equal(chooseEventId(item('newer', 'OpenAI releases new model Orion today', feb), [previous]), 'older');
  assert.equal(chooseEventId(item('different', 'NVIDIA ships new GPU', feb), [previous]), 'different');
  assert.equal(chooseEventId(item('late', 'OpenAI releases new model Orion', feb + 10 * 86_400_000), [previous]), 'late');
});

test('中英文同主体同版本同动作可聚合，不同版本不合并', () => {
  const at = Date.parse('2026-10-16T09:00:00Z');
  const official = { ...item('official', 'DeepSeek V4.1 released', at), entityIds: ['deepseek'] };
  const chinese = { ...item('cn', 'DeepSeek 发布 V4.1', at + 60_000), entityIds: ['deepseek'], language: 'zh' };
  assert.equal(chooseEventId(chinese, [official]), 'official');
  assert.equal(chooseEventId({ ...chinese, id: 'other', eventId: 'other', title: 'DeepSeek 发布 V4.2' }, [official]), 'other');
  assert.equal(chooseEventId({ ...chinese, id: 'update', eventId: 'update', eventTypeId: 'update' }, [official]), 'update');
});
