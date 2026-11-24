import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { sanitizeLogText } from './service-file-logging.mjs';

const DEFAULT_MAX_LINE_CHARS = 500;
const VALID_STATUSES = new Set(['running', 'completed', 'failed']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectRoot(text, root) {
  if (!root) return text;
  const normalizedRoot = path.resolve(root).replaceAll('\\', '/').replace(/\/$/, '');
  if (!normalizedRoot) return text;
  return text.replaceAll('\\', '/').replace(new RegExp(escapeRegExp(normalizedRoot), 'gi'), '…');
}

function fitLine(line, maxChars) {
  const characters = [...line];
  if (characters.length <= maxChars) return line;
  if (maxChars <= 1) return '…'.slice(0, maxChars);
  return `${characters.slice(0, maxChars - 1).join('')}…`;
}

function diagnosticPriority(line) {
  if (/\berror TS\d+\b|^npm (?:error|ERR!) network request\b/i.test(line)) return 4;
  if (/^npm (?:error|ERR!) code\b/i.test(line)) return 3;
  if (/^npm (?:error|ERR!)(?:\s|$)|^Error:/i.test(line)) return 2;
  if (/^✗\s/.test(line)) return 1;
  return 0;
}

export function createMaintenanceOutputStore(options = {}) {
  const now = options.now ?? Date.now;
  const root = options.root ?? null;
  const knownSecrets = options.knownSecrets ?? [];
  const sanitizeText = options.sanitizeText ?? ((value) => sanitizeLogText(value, knownSecrets));
  const maxLineChars = Math.max(1, options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS);
  let active = null;
  let diagnosticLine = null;
  let diagnosticScore = 0;
  let touchSequence = 0;

  const createChannel = () => ({ decoder: new StringDecoder('utf8'), buffer: '', pendingCr: false, touchedAt: 0 });
  const channels = { stdout: createChannel(), stderr: createChannel() };

  const sanitize = (value) => fitLine(
    projectRoot(sanitizeText(value), root).replace(/[\r\n]+/g, ' ').trim(),
    maxLineChars,
  );

  const commitLine = (operationId, value) => {
    if (!active || active.operationId !== operationId) return false;
    const line = sanitize(value);
    if (!line) return false;
    const priority = diagnosticPriority(line);
    if (priority > diagnosticScore) {
      diagnosticLine = line;
      diagnosticScore = priority;
    }
    active.lines = [...active.lines, line].slice(-2);
    active.sequence += 1;
    active.updatedAt = now();
    return true;
  };

  const resetChannels = () => {
    channels.stdout = createChannel();
    channels.stderr = createChannel();
    touchSequence = 0;
  };

  const consume = (operationId, channelName, input) => {
    if (!active || active.operationId !== operationId) return;
    const channel = channels[channelName];
    if (!channel) return;
    channel.touchedAt = ++touchSequence;
    const text = channel.decoder.write(Buffer.isBuffer(input) ? input : Buffer.from(String(input)));
    for (const character of text) {
      if (channel.pendingCr) {
        channel.pendingCr = false;
        if (character === '\n') {
          commitLine(operationId, channel.buffer);
          channel.buffer = '';
          continue;
        }
        channel.buffer = '';
      }
      if (character === '\r') {
        channel.pendingCr = true;
      } else if (character === '\n') {
        commitLine(operationId, channel.buffer);
        channel.buffer = '';
      } else {
        channel.buffer += character;
      }
    }
  };

  const flushChannels = (operationId) => {
    Object.values(channels)
      .filter((channel) => channel.buffer)
      .sort((left, right) => left.touchedAt - right.touchedAt)
      .forEach((channel) => {
        commitLine(operationId, channel.buffer);
        channel.buffer = '';
        channel.pendingCr = false;
      });
  };

  return {
    start(operationId) {
      if (typeof operationId !== 'string' || !operationId) return null;
      resetChannels();
      diagnosticLine = null;
      diagnosticScore = 0;
      active = { operationId, sequence: 1, lines: [], status: 'running', updatedAt: now() };
      return this.getSnapshot(operationId);
    },
    append(operationId, channel, chunk) {
      try { consume(operationId, channel, chunk); } catch {}
      return this.getSnapshot(operationId);
    },
    appendStage(operationId, line) {
      try { commitLine(operationId, line); } catch {}
      return this.getSnapshot(operationId);
    },
    finish(operationId, status) {
      if (!active || active.operationId !== operationId || !VALID_STATUSES.has(status) || status === 'running') return null;
      try { flushChannels(operationId); } catch {}
      if (status === 'failed' && diagnosticLine && active.lines.at(-1) !== diagnosticLine) commitLine(operationId, diagnosticLine);
      active.status = status;
      active.sequence += 1;
      active.updatedAt = now();
      return this.getSnapshot(operationId);
    },
    getSnapshot(operationId) {
      if (!active || active.operationId !== operationId) return null;
      return { ...active, lines: [...active.lines] };
    },
  };
}
