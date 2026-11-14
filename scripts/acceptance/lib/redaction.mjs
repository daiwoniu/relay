import path from 'node:path';
import { REPOSITORY_ROOT } from './paths.mjs';

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|stderr)/iu;
const MODEL_BODY_KEY = /(?:model|assistant|prompt|message).*(?:body|content|text)|^(?:prompt|content|body|responseText)$/iu;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']+/gu;
const POSIX_PATH = /\/(?:[^/\s"']+\/)+[^/\s"']+/gu;

export function redactReportValue(value, { repositoryRoot = REPOSITORY_ROOT } = {}) {
  return redact(value, path.resolve(repositoryRoot));
}

function redact(value, repositoryRoot) {
  if (Array.isArray(value)) return value.map((item) => redact(item, repositoryRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (SECRET_KEY.test(key)) return [key, '[REDACTED]'];
      if (MODEL_BODY_KEY.test(key)) return [key, '[REDACTED_MODEL_CONTENT]'];
      return [key, redact(item, repositoryRoot)];
    }));
  }
  if (typeof value !== 'string') return value;
  return redactPaths(redactInlineSecrets(value), repositoryRoot);
}

function redactInlineSecrets(value) {
  return value
    .replace(/\b(?:Cookie|Set-Cookie|Authorization)\s*[:=]\s*[^\r\n]+/giu, (match) => `${match.split(/[:=]/u, 1)[0]}: [REDACTED]`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gu, 'Bearer [REDACTED]')
    .replace(/\brelay_session=[^;\s,]+/gu, 'relay_session=[REDACTED]')
    .replace(/([?&](?:access_)?token=)[^&#\s]+/giu, '$1[REDACTED]');
}

function redactPaths(value, repositoryRoot) {
  const replace = (candidate) => isInside(repositoryRoot, candidate) ? candidate : '[EXTERNAL_PATH]';
  return value.replace(WINDOWS_PATH, replace).replace(POSIX_PATH, replace);
}

function isInside(root, candidate) {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}
