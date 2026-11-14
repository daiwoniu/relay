import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupLogFiles,
  createServiceFileLogger,
  redactLogText,
} from './lib/service-file-logging.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-service-log-'));
}

test('运行日志按服务与通道拼行并清理 ANSI 和敏感字段', async () => {
  const root = tempDir();
  const now = new Date(2026, 7, 12, 11, 35, 20, 123);
  const logger = createServiceFileLogger({ root, now: () => now, warn: () => {} });
  try {
    logger.writeServiceChunk('backend', 'stdout', Buffer.from('\u001b[31m启动 token=abc'));
    logger.writeServiceChunk('backend', 'stdout', Buffer.from('123\u001b[0m\n下一行'));
    logger.writeServiceChunk('frontend', 'stderr', Buffer.from('Authorization: Bearer secret\n'));
    await logger.close();
    const content = fs.readFileSync(logger.currentRunLogPath, 'utf8');
    assert.match(content, /^2026-08-12 11:35:20\.123 \[Relay 后端\] \[标准输出\] 启动 token=\[已隐藏\]$/m);
    assert.match(content, /\[Relay 前端\] \[标准错误\] Authorization: \[已隐藏\]/);
    assert.match(content, /\[Relay 后端\] \[标准输出\] 下一行/);
    assert.doesNotMatch(content, /\u001b|abc123|Bearer secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('环境修复输出使用独立安全日志标签', async () => {
  const root = tempDir();
  const logger = createServiceFileLogger({ root, warn: () => {} });
  try {
    logger.writeServiceChunk('setup', 'stdout', Buffer.from('npm ci 完成\n'));
    await logger.close();
    assert.match(fs.readFileSync(logger.currentRunLogPath, 'utf8'), /\[Relay 环境修复\] \[标准输出\] npm ci 完成/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UTF-8 中文字符跨 chunk 时保持完整', async () => {
  const root = tempDir();
  const logger = createServiceFileLogger({ root, warn: () => {} });
  try {
    const bytes = Buffer.from('中文完整\n');
    logger.writeServiceChunk('backend', 'stdout', bytes.subarray(0, 1));
    logger.writeServiceChunk('backend', 'stdout', bytes.subarray(1, 4));
    logger.writeServiceChunk('backend', 'stdout', bytes.subarray(4));
    await logger.close();
    const content = fs.readFileSync(logger.currentRunLogPath, 'utf8');
    assert.match(content, /中文完整/);
    assert.doesNotMatch(content, /�/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('脱敏覆盖 JSON、URL、环境变量和命令参数', () => {
  const input = '{"password":"hello","safe":"ok"} https://x.test?a=1&access_token=url-secret API_KEY=env-secret --secret cli-secret\nCookie: sid=cookie\nX-Relay-Token: relay-secret';
  const output = redactLogText(input, ['known-secret']);
  assert.match(output, /"password":"\[已隐藏\]"/);
  assert.match(output, /access_token=(?:\[已隐藏\]|%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D)/);
  assert.match(output, /API_KEY=\[已隐藏\]/);
  assert.match(output, /--secret \[已隐藏\]/);
  assert.match(output, /Cookie: \[已隐藏\]/);
  assert.match(output, /X-Relay-Token: \[已隐藏\]/);
  assert.doesNotMatch(output, /hello|url-secret|env-secret|cli-secret|sid=cookie|relay-secret/);
});

test('从已知令牌文件加载秘密并在运行日志中隐藏', async () => {
  const root = tempDir();
  const tokenFile = path.join(root, 'access-token');
  fs.writeFileSync(tokenFile, 'internal-file-secret');
  const logger = createServiceFileLogger({ root, knownSecretFiles: [tokenFile], warn: () => {} });
  try {
    logger.writeServiceChunk('backend', 'stderr', Buffer.from('内部值 internal-file-secret\n'));
    assert.equal(logger.sanitizeText('页面输出 internal-file-secret'), '页面输出 [已隐藏]');
    await logger.close();
    const content = fs.readFileSync(logger.currentRunLogPath, 'utf8');
    assert.match(content, /内部值 \[已隐藏\]/);
    assert.doesNotMatch(content, /internal-file-secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('关键生命周期事件同时写入运行日志和按月事件日志并执行脱敏', async () => {
  const root = tempDir();
  const now = new Date(2026, 7, 13, 0, 5, 6, 7);
  const logger = createServiceFileLogger({ root, now: () => now, warn: () => {} });
  try {
    logger.writeEvent('Relay 启动失败 token=event-secret');
    await logger.close();
    const eventContent = fs.readFileSync(path.join(root, 'logs', 'events-2026-08.log'), 'utf8');
    const runContent = fs.readFileSync(logger.currentRunLogPath, 'utf8');
    for (const content of [eventContent, runContent]) {
      assert.match(content, /^2026-08-13 00:05:06\.007 \[启动器\] \[事件\] Relay 启动失败 token=\[已隐藏\]$/m);
      assert.doesNotMatch(content, /event-secret/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('运行日志按大小轮转并递增三位序号', async () => {
  const root = tempDir();
  const now = new Date(2026, 7, 12, 8, 0, 0, 0);
  const logger = createServiceFileLogger({ root, now: () => now, maxRunFileBytes: 120, warn: () => {} });
  try {
    logger.writeServiceChunk('codex', 'stdout', Buffer.from(`${'甲'.repeat(40)}\n`));
    logger.writeServiceChunk('codex', 'stdout', Buffer.from(`${'乙'.repeat(40)}\n`));
    await logger.close();
    const names = fs.readdirSync(path.join(root, 'logs')).filter((name) => name.startsWith('relay-')).sort();
    assert.deepEqual(names, ['relay-2026-08-12-001.log', 'relay-2026-08-12-002.log']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同一天重启日志管理器时续写最后一个未满文件', async () => {
  const root = tempDir();
  const now = new Date(2026, 7, 12, 8, 0, 0, 0);
  const firstLogger = createServiceFileLogger({ root, now: () => now, warn: () => {} });
  try {
    firstLogger.writeEvent('Relay 启动开始（第一次）');
    await firstLogger.close();

    const secondLogger = createServiceFileLogger({ root, now: () => now, warn: () => {} });
    secondLogger.writeEvent('Relay 启动开始（第二次）');
    await secondLogger.close();

    const names = fs.readdirSync(path.join(root, 'logs')).filter((name) => name.startsWith('relay-')).sort();
    assert.deepEqual(names, ['relay-2026-08-12-001.log']);
    const content = fs.readFileSync(path.join(root, 'logs', names[0]), 'utf8');
    assert.match(content, /Relay 启动开始（第一次）/);
    assert.match(content, /Relay 启动开始（第二次）/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同一天重启时最后一个文件无法容纳下一行则递增序号', async () => {
  const root = tempDir();
  const now = new Date(2026, 7, 12, 8, 0, 0, 0);
  const firstLogger = createServiceFileLogger({ root, now: () => now, warn: () => {} });
  try {
    firstLogger.writeEvent('Relay 启动开始（第一次）');
    await firstLogger.close();
    const firstPath = path.join(root, 'logs', 'relay-2026-08-12-001.log');
    const firstSize = fs.statSync(firstPath).size;

    const secondLogger = createServiceFileLogger({
      root,
      now: () => now,
      maxRunFileBytes: firstSize,
      warn: () => {},
    });
    secondLogger.writeEvent('Relay 启动开始（第二次）');
    await secondLogger.close();

    const names = fs.readdirSync(path.join(root, 'logs')).filter((name) => name.startsWith('relay-')).sort();
    assert.deepEqual(names, ['relay-2026-08-12-001.log', 'relay-2026-08-12-002.log']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同一天重启时续写最后一个空文件并允许首行超过上限', async () => {
  const root = tempDir();
  const logsDir = path.join(root, 'logs');
  const now = new Date(2026, 7, 12, 8, 0, 0, 0);
  fs.mkdirSync(logsDir);
  fs.writeFileSync(path.join(logsDir, 'relay-2026-08-12-001.log'), '');
  const logger = createServiceFileLogger({ root, now: () => now, maxRunFileBytes: 1, warn: () => {} });
  try {
    logger.writeServiceChunk('backend', 'stdout', Buffer.from('首行\n'));
    await logger.close();
    const names = fs.readdirSync(logsDir).filter((name) => name.startsWith('relay-')).sort();
    assert.deepEqual(names, ['relay-2026-08-12-001.log']);
    assert.match(fs.readFileSync(path.join(logsDir, names[0]), 'utf8'), /首行/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('清理日志同时执行保留天数和总容量限制且跳过符号链接', () => {
  const root = tempDir();
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(logsDir);
  const write = (name, bytes, ageDays) => {
    const filePath = path.join(logsDir, name);
    fs.writeFileSync(filePath, 'x'.repeat(bytes));
    const date = new Date(2026, 7, 12 - ageDays, 8, 0, 0);
    fs.utimesSync(filePath, date, date);
    return filePath;
  };
  write('relay-2026-08-01-001.log', 20, 11);
  write('relay-2026-08-11-001.log', 80, 1);
  write('relay-2026-08-12-001.log', 80, 0);
  write('events-2026-04.log', 20, 120);
  write('events-2026-08.log', 80, 0);
  let symlinkCreated = false;
  try {
    fs.symlinkSync(path.join(logsDir, 'relay-2026-08-12-001.log'), path.join(logsDir, 'relay-2026-08-12-999.log'));
    symlinkCreated = true;
  } catch {}
  try {
    const result = cleanupLogFiles(logsDir, {
      now: new Date(2026, 7, 12, 8, 0, 0),
      runRetentionDays: 7,
      runTotalBytes: 100,
      eventRetentionDays: 90,
      eventTotalBytes: 100,
    });
    assert.equal(fs.existsSync(path.join(logsDir, 'relay-2026-08-01-001.log')), false);
    assert.equal(fs.existsSync(path.join(logsDir, 'relay-2026-08-11-001.log')), false);
    assert.equal(fs.existsSync(path.join(logsDir, 'relay-2026-08-12-001.log')), true);
    assert.equal(fs.existsSync(path.join(logsDir, 'events-2026-04.log')), false);
    assert.equal(fs.existsSync(path.join(logsDir, 'events-2026-08.log')), true);
    if (symlinkCreated) assert.equal(fs.lstatSync(path.join(logsDir, 'relay-2026-08-12-999.log')).isSymbolicLink(), true);
    assert.ok(result.deleted.length >= 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('运行日志默认保留 15 天且总量限制为 500 MiB', () => {
  const root = tempDir();
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(logsDir);
  const now = new Date(2026, 7, 20, 8, 0, 0);
  const writeSparse = (name, bytes, ageDays) => {
    const filePath = path.join(logsDir, name);
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, bytes);
    const date = new Date(now);
    date.setDate(date.getDate() - ageDays);
    fs.utimesSync(filePath, date, date);
  };
  writeSparse('relay-2026-08-04-001.log', 1, 16);
  writeSparse('relay-2026-08-06-001.log', 300 * 1024 * 1024, 14);
  writeSparse('relay-2026-08-20-001.log', 250 * 1024 * 1024, 0);
  try {
    cleanupLogFiles(logsDir, { now });
    assert.equal(fs.existsSync(path.join(logsDir, 'relay-2026-08-04-001.log')), false);
    assert.equal(fs.existsSync(path.join(logsDir, 'relay-2026-08-06-001.log')), false);
    assert.equal(fs.existsSync(path.join(logsDir, 'relay-2026-08-20-001.log')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('日志目录不可用时只警告一次且调用方继续运行', async () => {
  const root = tempDir();
  const blockingFile = path.join(root, 'blocked');
  fs.writeFileSync(blockingFile, 'not a directory');
  const warnings = [];
  const logger = createServiceFileLogger({ root: blockingFile, warn: (message) => warnings.push(message) });
  logger.writeServiceChunk('backend', 'stdout', Buffer.from('still running\n'));
  logger.writeEvent('启动器继续运行');
  await logger.close();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /日志/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('拒绝跟随项目 logs 符号链接写入外部目录', async () => {
  const root = tempDir();
  const outside = tempDir();
  const warnings = [];
  let linked = false;
  try {
    try {
      fs.symlinkSync(outside, path.join(root, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch {}
    if (!linked) return;
    const logger = createServiceFileLogger({ root, warn: (message) => warnings.push(message) });
    logger.writeServiceChunk('backend', 'stdout', Buffer.from('不得越界\n'));
    await logger.close();
    assert.equal(warnings.length, 1);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('队列溢出停止接收新日志但排空已接受事件', async () => {
  const root = tempDir();
  const warnings = [];
  const logger = createServiceFileLogger({ root, maxBufferedBytes: 160, warn: (message) => warnings.push(message) });
  try {
    logger.writeEvent('必须保留');
    logger.writeEvent('X'.repeat(300));
    await logger.close();
    const eventPath = path.join(root, 'logs', `events-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}.log`);
    assert.match(fs.readFileSync(eventPath, 'utf8'), /必须保留/);
    assert.equal(warnings.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('队列溢出后关闭仍排空此前已接收的无换行残留', async () => {
  const root = tempDir();
  const warnings = [];
  const logger = createServiceFileLogger({ root, maxBufferedBytes: 180, warn: (message) => warnings.push(message) });
  try {
    logger.writeServiceChunk('backend', 'stdout', Buffer.from('关闭前残留'));
    logger.writeEvent('X'.repeat(300));
    await logger.close();
    assert.match(fs.readFileSync(logger.currentRunLogPath, 'utf8'), /关闭前残留/);
    assert.equal(warnings.length, 1);
    assert.equal(logger.bufferedBytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('无换行超长输出受内存上限约束并安全降级', async () => {
  const root = tempDir();
  const warnings = [];
  const logger = createServiceFileLogger({ root, maxBufferedBytes: 128, warn: (message) => warnings.push(message) });
  try {
    logger.writeServiceChunk('backend', 'stdout', Buffer.from('N'.repeat(4096)));
    await logger.close();
    assert.equal(warnings.length, 1);
    assert.equal(logger.bufferedBytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('多个服务通道的无换行残留共同受内存上限约束', async () => {
  const root = tempDir();
  const warnings = [];
  const logger = createServiceFileLogger({ root, maxBufferedBytes: 128, warn: (message) => warnings.push(message) });
  try {
    logger.writeServiceChunk('backend', 'stdout', Buffer.from('A'.repeat(80)));
    logger.writeServiceChunk('frontend', 'stderr', Buffer.from('B'.repeat(80)));
    await logger.close();
    assert.equal(warnings.length, 1);
    assert.equal(logger.bufferedBytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同日和同月持续写入后总容量收敛并保留最新日志', async () => {
  const root = tempDir();
  const now = new Date(2026, 7, 13, 1, 2, 3, 4);
  const logger = createServiceFileLogger({
    root,
    now: () => now,
    maxRunFileBytes: 190,
    runTotalBytes: 380,
    eventTotalBytes: 260,
    maxBufferedBytes: 16_000,
    warn: () => {},
  });
  try {
    for (const marker of ['RUN-1', 'RUN-2', 'RUN-3', 'RUN-4']) {
      logger.writeServiceChunk('backend', 'stdout', Buffer.from(`${marker} ${'R'.repeat(90)}\n`));
    }
    for (const marker of ['EVENT-1', 'EVENT-2', 'EVENT-3', 'EVENT-4']) logger.writeEvent(`${marker} ${'E'.repeat(70)}`);
    await logger.close();
    const logsDir = path.join(root, 'logs');
    const runFiles = fs.readdirSync(logsDir).filter((name) => name.startsWith('relay-'));
    const runBytes = runFiles.reduce((total, name) => total + fs.statSync(path.join(logsDir, name)).size, 0);
    const eventPath = path.join(logsDir, 'events-2026-08.log');
    assert.ok(runBytes <= 380, `运行日志实际 ${runBytes} 字节`);
    assert.ok(fs.statSync(eventPath).size <= 260, `事件日志实际 ${fs.statSync(eventPath).size} 字节`);
    assert.match(fs.readFileSync(eventPath, 'utf8'), /EVENT-4/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('单条超大事件也严格收敛到事件日志总量上限', async () => {
  const root = tempDir();
  const now = new Date(2026, 7, 13, 1, 2, 3, 4);
  const logger = createServiceFileLogger({
    root,
    now: () => now,
    eventTotalBytes: 180,
    maxBufferedBytes: 2_000,
    warn: () => {},
  });
  try {
    logger.writeEvent(`LATEST ${'大'.repeat(500)}`);
    await logger.close();
    const eventPath = path.join(root, 'logs', 'events-2026-08.log');
    const content = fs.readFileSync(eventPath, 'utf8');
    assert.ok(fs.statSync(eventPath).size <= 180);
    assert.match(content, /LATEST/);
    assert.match(content, /已截断/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
