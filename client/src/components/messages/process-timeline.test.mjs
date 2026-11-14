import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProcessTimelineSections, getDefaultExpandedNarrativeItemId, getProcessNarrativeStatus } from './process-timeline.ts';

const step = (id, type = 'commandExecution', status = 'in_progress') => ({ id, type, status, details: {} });

test('说明只在时间线末段仍追加时进行中，后续操作到达后归为已完成', () => {
  const timeline=[{type:'narrative',itemId:'note',content:'正在检查'}];
  assert.equal(getProcessNarrativeStatus(timeline,'note',false),'in_progress');
  assert.equal(getProcessNarrativeStatus([...timeline,{type:'operation',itemId:'tool'}],'note',false),'completed');
  assert.equal(getProcessNarrativeStatus(timeline,'note',false,'stopped'),'stopped');
  assert.equal(getProcessNarrativeStatus(timeline,'note',true),'completed');
});

test('每两段过程回复之间形成各自独立的执行过程组', () => {
  const sections = buildProcessTimelineSections([
    { type: 'narrative', itemId: 'reply-a', content: '回复 A' },
    { type: 'operation', itemId: 'command-a' },
    { type: 'narrative', itemId: 'reply-b', content: '回复 B' },
    { type: 'operation', itemId: 'command-b' },
  ], [step('command-a', 'commandExecution', 'completed'), step('command-b')]);

  assert.deepEqual(sections.map((section) => section.type), [
    'narrative', 'execution', 'narrative', 'execution',
  ]);
  assert.deepEqual(sections[1].sections.map((section) => section.type), ['operations']);
  assert.deepEqual(sections[1].steps.map((item) => item.id), ['command-a']);
  assert.deepEqual(sections[3].steps.map((item) => item.id), ['command-b']);
});

test('同一间隔内相邻普通操作汇总到一个组', () => {
  const sections = buildProcessTimelineSections([
    { type: 'narrative', itemId: 'reply-a', content: '回复 A' },
    { type: 'operation', itemId: 'command-a' },
    { type: 'operation', itemId: 'command-b' },
  ], [step('command-a'), step('command-b')]);

  assert.equal(sections.length, 2);
  assert.deepEqual(sections[1].sections.map((section) => section.type), ['operations']);
  assert.deepEqual(sections[1].sections[0].steps.map((item) => item.id), ['command-a', 'command-b']);
});

test('同一普通操作组流式追加步骤时保持稳定 key', () => {
  const initialSections = buildProcessTimelineSections([
    { type: 'operation', itemId: 'command-a' },
  ], [step('command-a')]);
  const appendedSections = buildProcessTimelineSections([
    { type: 'operation', itemId: 'command-a' },
    { type: 'operation', itemId: 'command-b' },
  ], [step('command-a'), step('command-b')]);

  assert.equal(initialSections[0].sections[0].key, appendedSections[0].sections[0].key);
});

test('interaction 保留在同一执行过程组内并切断普通操作组', () => {
  const sections = buildProcessTimelineSections([
    { type: 'operation', itemId: 'command-a' },
    { type: 'operation', itemId: 'approval-a' },
    { type: 'operation', itemId: 'command-b' },
  ], [step('command-a'), step('approval-a', 'interaction'), step('command-b')]);

  assert.deepEqual(sections.map((section) => section.type), ['execution']);
  assert.deepEqual(sections[0].sections.map((section) => section.type), ['operations', 'interaction', 'operations']);
  assert.notEqual(sections[0].sections[0].key, sections[0].sections[2].key);
});

test('子任务保留在同一执行过程组内并切断普通操作组', () => {
  const sections = buildProcessTimelineSections([
    { type: 'operation', itemId: 'command-a' },
    { type: 'operation', itemId: 'subtask-a' },
    { type: 'operation', itemId: 'command-b' },
  ], [
    step('command-a'),
    { ...step('subtask-a', 'collabAgentToolCall'), details: { tool: 'spawnAgent' } },
    step('command-b'),
  ]);

  assert.deepEqual(sections.map((section) => section.type), ['execution']);
  assert.deepEqual(sections[0].sections.map((section) => section.type), ['operations', 'subtask', 'operations']);
  assert.deepEqual(sections[0].sections[0].steps.map((item) => item.id), ['command-a']);
  assert.equal(sections[0].sections[1].step.id, 'subtask-a');
  assert.deepEqual(sections[0].sections[2].steps.map((item) => item.id), ['command-b']);
});

test('子代理活动也作为独立子任务区块展示', () => {
  const sections = buildProcessTimelineSections([
    { type: 'operation', itemId: 'activity-a' },
  ], [step('activity-a', 'subAgentActivity')]);

  assert.deepEqual(sections.map((section) => section.type), ['execution']);
  assert.deepEqual(sections[0].sections.map((section) => section.type), ['subtask']);
});

test('没有任务信息的等待操作留在普通操作组', () => {
  const sections = buildProcessTimelineSections([
    { type: 'operation', itemId: 'wait-a' },
  ], [{
    id: 'wait-a',
    type: 'collabAgentToolCall',
    status: 'completed',
    details: { tool: 'wait' },
  }]);

  assert.deepEqual(sections.map((section) => section.type), ['execution']);
  assert.deepEqual(sections[0].sections.map((section) => section.type), ['operations']);
});

test('操作可以先于第一段过程回复出现', () => {
  const sections = buildProcessTimelineSections([
    { type: 'operation', itemId: 'command-a' },
    { type: 'narrative', itemId: 'reply-a', content: '回复 A' },
  ], [step('command-a')]);

  assert.deepEqual(sections.map((section) => section.type), ['execution', 'narrative']);
});

test('处理中默认展开最后一段过程回复，即使其后已有操作', () => {
  const timeline = [
    { type: 'narrative', itemId: 'reply-a', content: '回复 A' },
    { type: 'operation', itemId: 'command-a' },
    { type: 'narrative', itemId: 'reply-b', content: '回复 B' },
    { type: 'operation', itemId: 'command-b' },
  ];

  assert.equal(getDefaultExpandedNarrativeItemId(timeline, false), 'reply-b');
  assert.equal(getDefaultExpandedNarrativeItemId(timeline, true), null);
});

test('只有操作且尚无过程回复时不展开任何回复', () => {
  assert.equal(getDefaultExpandedNarrativeItemId([
    { type: 'operation', itemId: 'command-a' },
  ], false), null);
});
