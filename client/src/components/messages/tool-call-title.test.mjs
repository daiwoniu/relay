import assert from 'node:assert/strict';
import test from 'node:test';
import { getToolCallTitle } from './tool-call-title.ts';

test('工具参数对象中的 title 优先于工具实现名', () => {
  assert.equal(
    getToolCallTitle({ title: '检查 Relay 数据目录', timeout_ms: 30_000 }, 'js'),
    '检查 Relay 数据目录',
  );
});

test('序列化 JSON 参数同样提取语义标题', () => {
  assert.equal(
    getToolCallTitle('{"title":"读取项目状态","code":"..."}', 'js'),
    '读取项目状态',
  );
});

test('缺少有效 title 时保留工具名兜底', () => {
  assert.equal(getToolCallTitle({ title: '   ' }, 'js'), 'js');
  assert.equal(getToolCallTitle('{broken', 'js'), 'js');
});
