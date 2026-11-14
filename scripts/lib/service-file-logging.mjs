import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const DEFAULTS = Object.freeze({
  maxRunFileBytes: 10 * 1024 * 1024,
  runRetentionDays: 15,
  runTotalBytes: 500 * 1024 * 1024,
  eventRetentionDays: 90,
  eventTotalBytes: 20 * 1024 * 1024,
});

const SERVICE_LABELS = Object.freeze({
  launcher: '启动器',
  codex: 'Codex',
  backend: 'Relay 后端',
  frontend: 'Relay 前端',
  'frontend-build': '前端生产构建',
  codebuddy: 'CodeBuddy',
  setup: 'Relay 环境修复',
  'codex-maintenance': 'Codex 维护',
  'codebuddy-maintenance': 'CodeBuddy 维护',
  'codebuddy-readiness': 'CodeBuddy 检测',
});

const CHANNEL_LABELS = Object.freeze({ stdout: '标准输出', stderr: '标准错误', event: '事件' });
const SECRET_KEY = '(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)';

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

function localDateParts(date) {
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    month: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`,
    timestamp: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
  };
}

export function stripAnsi(text) {
  return String(text)
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactLogText(input, knownSecrets = []) {
  let text = String(input);
  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret) text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[已隐藏]');
  }
  text = text.replace(new RegExp(`("${SECRET_KEY}"\\s*:\\s*")([^"]*)(")`, 'gi'), '$1[已隐藏]$3');
  text = text.replace(new RegExp(`(^|[?&])(${SECRET_KEY})=([^&#\\s]+)`, 'gi'), (_, prefix, key) => `${prefix}${key}=${encodeURIComponent('[已隐藏]')}`);
  text = text.replace(new RegExp(`\\b(${SECRET_KEY})=([^\\s,;]+)`, 'gi'), '$1=[已隐藏]');
  text = text.replace(new RegExp(`(--${SECRET_KEY})(?:=|\\s+)([^\\s]+)`, 'gi'), '$1 [已隐藏]');
  text = text.replace(new RegExp(`\\b(Authorization|Cookie|Set-Cookie|X-Relay-Token)\\s*:\\s*.*$`, 'gim'), '$1: [已隐藏]');
  return text;
}

export function sanitizeLogText(input, knownSecrets = []) {
  return redactLogText(stripAnsi(input), knownSecrets);
}

function safeLogLine(serviceId, channel, content, now, knownSecrets) {
  const clean = sanitizeLogText(content, knownSecrets).replace(/\r$/, '');
  if (!clean) return null;
  const { timestamp } = localDateParts(now);
  return `${timestamp} [${SERVICE_LABELS[serviceId] || serviceId}] [${CHANNEL_LABELS[channel] || channel}] ${clean}\n`;
}

function listManagedFiles(logsDir, prefix) {
  if (!fs.existsSync(logsDir)) return [];
  const pattern = prefix === 'relay'
    ? /^relay-\d{4}-\d{2}-\d{2}-\d{3}\.log$/
    : /^events-\d{4}-\d{2}\.log$/;
  return fs.readdirSync(logsDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !pattern.test(entry.name)) return [];
    const filePath = path.join(logsDir, entry.name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    return [{ path: filePath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs }];
  });
}

function cleanupGroup(files, retentionDays, totalBytes, nowMs, deleted, protectedPaths = new Set()) {
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const remaining = [];
  for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))) {
    if (file.mtimeMs < cutoff && !protectedPaths.has(file.path)) {
      fs.unlinkSync(file.path);
      deleted.push(file.path);
    } else {
      remaining.push(file);
    }
  }
  let size = remaining.reduce((total, file) => total + file.size, 0);
  while (size > totalBytes) {
    const index = remaining.findIndex((file) => !protectedPaths.has(file.path));
    if (index < 0) break;
    const [file] = remaining.splice(index, 1);
    fs.unlinkSync(file.path);
    deleted.push(file.path);
    size -= file.size;
  }
}

export function cleanupLogFiles(logsDir, options = {}) {
  const deleted = [];
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const protectedPaths = new Set((options.protectedPaths || []).map((filePath) => path.resolve(filePath)));
  cleanupGroup(
    listManagedFiles(logsDir, 'relay'),
    options.runRetentionDays ?? DEFAULTS.runRetentionDays,
    options.runTotalBytes ?? DEFAULTS.runTotalBytes,
    now.getTime(),
    deleted,
    protectedPaths,
  );
  cleanupGroup(
    listManagedFiles(logsDir, 'events'),
    options.eventRetentionDays ?? DEFAULTS.eventRetentionDays,
    options.eventTotalBytes ?? DEFAULTS.eventTotalBytes,
    now.getTime(),
    deleted,
    protectedPaths,
  );
  return { deleted };
}

function nextRunLogPath(logsDir, date) {
  const names = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
  const pattern = new RegExp(`^relay-${date}-(\\d{3})\\.log$`);
  const highest = names.reduce((value, name) => Math.max(value, Number(pattern.exec(name)?.[1] || 0)), 0);
  return path.join(logsDir, `relay-${date}-${pad(highest + 1, 3)}.log`);
}

function latestRunLogFile(logsDir, date) {
  if (!fs.existsSync(logsDir)) return null;
  const pattern = new RegExp(`^relay-${date}-(\\d{3})\\.log$`);
  return fs.readdirSync(logsDir, { withFileTypes: true }).reduce((latest, entry) => {
    const match = pattern.exec(entry.name);
    if (!match || !entry.isFile()) return latest;
    const filePath = path.join(logsDir, entry.name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return latest;
    const sequence = Number(match[1]);
    return !latest || sequence > latest.sequence
      ? { path: filePath, sequence, size: stat.size }
      : latest;
  }, null);
}

async function trimLogFileToLatestLines(filePath, maxBytes) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= maxBytes) return;
  const content = await fs.promises.readFile(filePath, 'utf8');
  const lines = content.split(/(?<=\n)/);
  let size = 0;
  const kept = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    const bytes = Buffer.byteLength(line);
    if (kept.length > 0 && size + bytes > maxBytes) break;
    kept.unshift(line);
    size += bytes;
  }
  await fs.promises.writeFile(filePath, kept.join(''), { encoding: 'utf8', mode: 0o600 });
}

function fitLineToBytes(line, maxBytes) {
  if (Buffer.byteLength(line) <= maxBytes) return line;
  const suffix = '…[已截断]\n';
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) {
    let result = '';
    for (const character of suffix) {
      if (Buffer.byteLength(result + character) > maxBytes) break;
      result += character;
    }
    return result;
  }
  let low = 0;
  let high = line.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const end = /[\uD800-\uDBFF]/.test(line[middle - 1] || '') ? middle - 1 : middle;
    if (Buffer.byteLength(line.slice(0, end)) + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (/[\uD800-\uDBFF]/.test(line[end - 1] || '')) end -= 1;
  while (end > 0 && Buffer.byteLength(line.slice(0, end)) + suffixBytes > maxBytes) end -= 1;
  return `${line.slice(0, end)}${suffix}`;
}

export function createServiceFileLogger(options = {}) {
  const root = options.root || process.cwd();
  const logsDir = path.join(root, 'logs');
  const now = options.now || (() => new Date());
  const warn = options.warn || console.warn;
  const knownSecrets = (options.knownSecrets || []).filter((value) => typeof value === 'string' && value);
  for (const filePath of options.knownSecretFiles || []) {
    try {
      const value = fs.readFileSync(filePath, 'utf8').trim();
      if (value) knownSecrets.push(value);
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`Relay 日志无法读取已知秘密文件，继续使用规则脱敏：${error.message}`);
    }
  }
  const maxRunFileBytes = options.maxRunFileBytes ?? DEFAULTS.maxRunFileBytes;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  const buffers = new Map();
  const decoders = new Map();
  let accepting = true;
  let writable = true;
  let warned = false;
  let currentDate = null;
  let currentEventMonth = null;
  let runLogPath = null;
  let pending = Promise.resolve();
  let bufferedBytes = 0;

  const bufferedFragmentBytes = () => [...buffers.values()]
    .reduce((total, value) => total + Buffer.byteLength(value), 0);

  const disable = (error) => {
    accepting = false;
    writable = false;
    if (warned) return;
    warned = true;
    warn(`Relay 文件日志不可用，已降级为终端与内存诊断：${error instanceof Error ? error.message : String(error)}`);
  };

  const stopAccepting = (error) => {
    accepting = false;
    if (warned) return;
    warned = true;
    warn(`Relay 文件日志待写内容超过内存上限，已停止接收本次启动的新日志：${error.message}`);
  };

  try {
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(logsDir);
    const rootReal = fs.realpathSync(root);
    const logsReal = fs.realpathSync(logsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(logsReal) !== rootReal) {
      throw new Error('logs 目录不是项目根目录下的真实目录');
    }
    cleanupLogFiles(logsDir, { ...DEFAULTS, ...options, now: now() });
  } catch (error) {
    disable(error);
  }

  const enqueue = (bytes, operation, accepted = false) => {
    if (!accepting && !accepted) return;
    if (!accepted && bufferedBytes + bufferedFragmentBytes() + bytes > maxBufferedBytes) {
      stopAccepting(new Error('待写日志超过内存上限'));
      return;
    }
    bufferedBytes += bytes;
    pending = pending.then(async () => {
      if (!writable) return;
      await operation();
    }).catch(disable).finally(() => {
      bufferedBytes -= bytes;
    });
  };

  const ensureRunPath = (date, lineBytes) => {
    if (date !== currentDate) {
      currentDate = date;
      const latest = latestRunLogFile(logsDir, date);
      runLogPath = latest && (latest.size === 0 || latest.size + lineBytes <= maxRunFileBytes)
        ? latest.path
        : nextRunLogPath(logsDir, date);
      cleanupLogFiles(logsDir, { ...DEFAULTS, ...options, now: now() });
    }
    const size = fs.existsSync(runLogPath) ? fs.statSync(runLogPath).size : 0;
    if (size > 0 && size + lineBytes > maxRunFileBytes) {
      runLogPath = nextRunLogPath(logsDir, date);
      cleanupLogFiles(logsDir, { ...DEFAULTS, ...options, now: now() });
    }
    return runLogPath;
  };

  const appendRunLine = (line, at, accepted = false) => {
    if ((!accepting && !accepted) || !line) return;
    const bytes = Buffer.byteLength(line);
    enqueue(bytes, async () => {
      const { date } = localDateParts(at);
      const targetPath = ensureRunPath(date, bytes);
      await fs.promises.appendFile(targetPath, line, { encoding: 'utf8', mode: 0o600 });
      cleanupLogFiles(logsDir, { ...DEFAULTS, ...options, now: at, protectedPaths: [targetPath] });
    }, accepted);
  };

  const writeServiceLine = (serviceId, channel, content, accepted = false) => {
    try {
      const at = now();
      appendRunLine(safeLogLine(serviceId, channel, content, at, knownSecrets), at, accepted);
    } catch (error) {
      disable(error);
    }
  };

  const writeServiceChunk = (serviceId, channel, chunk) => {
    if (!accepting) return;
    try {
      const key = `${serviceId}:${channel}`;
      let decoder = decoders.get(key);
      if (!decoder) {
        decoder = new StringDecoder('utf8');
        decoders.set(key, decoder);
      }
      const decoded = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      const previous = buffers.get(key) || '';
      const combined = `${previous}${decoded}`;
      const nextFragmentBytes = bufferedFragmentBytes()
        - Buffer.byteLength(previous)
        + Buffer.byteLength(combined);
      if (nextFragmentBytes + bufferedBytes > maxBufferedBytes) {
        buffers.clear();
        for (const activeDecoder of decoders.values()) activeDecoder.end();
        decoders.clear();
        stopAccepting(new Error('未换行日志超过内存上限'));
        return;
      }
      const lines = combined.split(/\r?\n/);
      buffers.set(key, lines.pop() || '');
      for (const line of lines) writeServiceLine(serviceId, channel, line);
    } catch (error) {
      disable(error);
    }
  };

  const flushService = (serviceId) => {
    for (const channel of ['stdout', 'stderr']) {
      const key = `${serviceId}:${channel}`;
      const decoder = decoders.get(key);
      const value = `${buffers.get(key) || ''}${decoder?.end() || ''}`;
      buffers.delete(key);
      decoders.delete(key);
      if (value) writeServiceLine(serviceId, channel, value, true);
    }
  };

  const writeEvent = (content, serviceId = 'launcher') => {
    if (!accepting) return;
    try {
      const at = now();
      const { date, month } = localDateParts(at);
      const runLine = safeLogLine(serviceId, 'event', content, at, knownSecrets);
      if (!runLine) return;
      const line = fitLineToBytes(
        runLine,
        options.eventTotalBytes ?? DEFAULTS.eventTotalBytes,
      );
      if (!line) return;
      const runBytes = Buffer.byteLength(runLine);
      const queuedBytes = runBytes + (line === runLine ? 0 : Buffer.byteLength(line));
      enqueue(queuedBytes, async () => {
        const targetPath = ensureRunPath(date, runBytes);
        await fs.promises.appendFile(targetPath, runLine, { encoding: 'utf8', mode: 0o600 });
        if (month !== currentEventMonth) {
          currentEventMonth = month;
          cleanupLogFiles(logsDir, { ...DEFAULTS, ...options, now: at, protectedPaths: [targetPath] });
        }
        const eventPath = path.join(logsDir, `events-${month}.log`);
        await fs.promises.appendFile(eventPath, line, { encoding: 'utf8', mode: 0o600 });
        await trimLogFileToLatestLines(eventPath, options.eventTotalBytes ?? DEFAULTS.eventTotalBytes);
        cleanupLogFiles(logsDir, { ...DEFAULTS, ...options, now: at, protectedPaths: [targetPath, eventPath] });
      });
    } catch (error) {
      disable(error);
    }
  };

  const close = async () => {
    for (const key of [...buffers.keys()]) flushService(key.split(':')[0]);
    await pending;
  };

  return {
    logsDir,
    get currentRunLogPath() { return runLogPath; },
    get enabled() { return accepting && writable; },
    get bufferedBytes() {
      return bufferedBytes + bufferedFragmentBytes();
    },
    writeServiceChunk,
    flushService,
    writeEvent,
    sanitizeText: (input) => sanitizeLogText(input, knownSecrets),
    close,
  };
}
