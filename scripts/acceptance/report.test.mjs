import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aggregateReportStatus, aggregateScenarioStatus, createScenarioResult, writeAcceptanceReport } from './lib/report.mjs';
import { redactReportValue } from './lib/redaction.mjs';

test('报告脱敏 Cookie、Authorization、密码、token、stderr、模型正文和项目外路径', () => {
  const root = path.resolve('G:/AI/relay');
  const redacted = redactReportValue({
    headers: { Cookie: 'relay_session=secret-cookie', Authorization: 'Bearer secret-bearer', 'Set-Cookie': 'relay_session=secret-set-cookie; HttpOnly' },
    password: 'secret-password', accessToken: 'secret-token', stderr: 'fatal secret-stderr', content: 'private assistant response',
    detail: `inside ${path.join(root, 'scripts', 'acceptance')} outside C:\\Users\\someone\\secret.txt`,
  }, { repositoryRoot: root });
  const serialized = JSON.stringify(redacted);
  for (const secret of ['secret-cookie', 'secret-bearer', 'secret-set-cookie', 'secret-password', 'secret-token', 'secret-stderr', 'private assistant response', 'someone']) assert.equal(serialized.includes(secret), false, secret);
  assert.match(redacted.detail, /scripts[\\/]acceptance/u);
  assert.match(redacted.detail, /\[EXTERNAL_PATH\]/u);
});

test('场景状态只接受固定四种值', () => {
  for (const status of ['passed', 'failed', 'inconclusive', 'manual_required']) assert.equal(createScenarioResult({ id: status, status }).status, status);
  assert.throws(() => createScenarioResult({ id: 'bad', status: 'skipped' }), /状态/u);
});

test('阻断性 inconclusive 不聚合为通过', () => {
  assert.equal(aggregateScenarioStatus([{ status: 'passed' }, { status: 'inconclusive' }]), 'inconclusive');
  assert.equal(aggregateScenarioStatus([{ status: 'passed' }, { status: 'failed' }]), 'failed');
  assert.equal(aggregateScenarioStatus([{ status: 'passed' }, { status: 'manual_required' }]), 'manual_required');
  assert.equal(aggregateScenarioStatus([{ status: 'passed' }]), 'passed');
  assert.equal(aggregateReportStatus([{ status: 'passed' }], { process: 'remaining', port: 'released', profile: 'removed' }), 'failed');
});

test('报告只写入运行目录并生成 JSON 与 Markdown 摘要', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-report-'));
  const runDir = path.join(root, 'run-a');
  fs.mkdirSync(runDir);
  const result = writeAcceptanceReport({ runDir, report: { runId: 'run-a', scenarios: [{ id: 'desktop', status: 'passed', detail: 'ok' }] }, acceptanceRoot: root });
  assert.equal(fs.existsSync(result.jsonPath), true);
  assert.equal(fs.existsSync(result.summaryPath), true);
  assert.equal(JSON.parse(fs.readFileSync(result.jsonPath, 'utf8')).status, 'passed');
  assert.match(fs.readFileSync(result.summaryPath, 'utf8'), /desktop.*passed/u);
  assert.throws(() => writeAcceptanceReport({ runDir: path.join(root, '..', 'outside'), report: { scenarios: [] }, acceptanceRoot: root }), /越界/u);
});
