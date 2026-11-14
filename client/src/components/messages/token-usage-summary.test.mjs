import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const summarySource = await readFile(new URL('./TokenUsageSummary.tsx', import.meta.url), 'utf8');
const assistantSource = await readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');
const styleSource = readStyleSource();

test('气泡状态栏只接入一个输出计数', () => {
  assert.match(assistantSource, /<TokenUsageSummary tokenUsage=\{tokenUsage\} mobile=\{mobile\} \/>/);
  assert.doesNotMatch(assistantSource, /输出Tokens/);
  assert.match(summarySource, />\s*输出 ≈ \{presentation\.outputTokens\.toLocaleString\(\)\}\s*<\/button>/);
  assert.doesNotMatch(summarySource, /· 输出/);
});

test('状态与输出分隔点使用独立紧凑间距', () => {
  assert.match(assistantSource, /<span className="inline-flex items-center gap-1">\s*<span className="font-medium">\{status\.label\}<\/span>[\s\S]*?<span className="text-\[var\(--color-text-tertiary\)\]" aria-hidden="true">·<\/span>[\s\S]*?<TokenUsageSummary/);
  assert.match(styleSource, /\.assistant-message__usage \{[\s\S]*?padding: 0 0\.125rem 0 0;/);
  assert.match(assistantSource, /<div className="inline-flex flex-wrap items-center gap-1\.5">/);
});

test('气泡明细统一显示本轮累计输出估算', () => {
  assert.match(summarySource, /<HoverCard/);
  assert.match(summarySource, /disabled=\{mobile\}/);
  assert.match(summarySource, /openOnClick/);
  assert.match(summarySource, /onClick=\{\(\) => \{ if \(mobile\) setDetailsOpen\(true\); \}\}/);
  assert.match(summarySource, /<DetailsDialog/);
  assert.match(summarySource, /w-max max-w-full/);
  assert.match(summarySource, /本轮累计输出用量（估算）/);
  assert.match(summarySource, /累计其他输出 Tokens/);
  assert.doesNotMatch(summarySource, /输入 Tokens|缓存 Tokens|本轮总计 Tokens/);
  assert.match(summarySource, /过程快照累加估算/);
});
