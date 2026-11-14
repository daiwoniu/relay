const CONTROL_KEYS = [
  'channel',
  'type',
  'operationId',
  'target',
  'requestedBy',
  'clientProtocolVersion',
  'serverProtocolVersion',
];

const COMMIT_KEYS = ['channel', 'type', 'operationId', 'target'];

const RESPONSE_KEYS = [
  'channel',
  'type',
  'operationId',
  'target',
  'status',
  'reason',
  'retryAfterMs',
  'message',
];

const RESPONSE_STATUSES = ['accepted', 'rejected', 'completed', 'failed'];
const RESPONSE_REASONS = [
  'operation_in_progress',
  'rate_limited',
  'target_unavailable',
  'restart_failed',
  'setup_required',
  'setup_blocked',
];

const STATUS_REQUEST_KEYS = ['channel', 'type', 'requestId'];
const STATUS_RESPONSE_KEYS = [
  'channel',
  'type',
  'requestId',
  'backendRetryAfterMs',
  'frontendRetryAfterMs',
  'operationInProgress',
];
const MAINTENANCE_OUTPUT_REQUEST_KEYS = ['channel', 'type', 'requestId', 'operationId'];
const MAINTENANCE_OUTPUT_RESPONSE_KEYS = ['channel', 'type', 'requestId', 'operationId', 'output'];
const MAINTENANCE_OUTPUT_KEYS = ['operationId', 'sequence', 'lines', 'status', 'updatedAt'];
const ENGINE_CONTROL_KEYS = ['channel', 'type', 'operationId', 'engineId', 'action', 'requestedBy', 'workspaceRoots'];
const ENGINE_COMMIT_KEYS = ['channel', 'type', 'operationId', 'engineId', 'action'];
const ENGINE_ABORT_KEYS = ['channel', 'type', 'operationId', 'engineId', 'action'];
const ENGINE_RESPONSE_KEYS = ['channel', 'type', 'operationId', 'engineId', 'action', 'status', 'reason', 'retryAfterMs'];
const ENGINE_ACTIONS = new Map([
  ['codex', new Set(['install', 'restart', 'upgrade_and_restart'])],
  ['codebuddy', new Set(['install', 'upgrade', 'recheck'])],
  ['opencode', new Set(['install', 'upgrade', 'recheck'])],
]);
const ENGINE_RESPONSE_REASONS = [
  'operation_in_progress',
  'rate_limited',
  'target_unavailable',
  'action_blocked',
  'upgrade_unsupported',
  'setup_required',
  'setup_blocked',
  'upgrade_failed',
  'restart_failed',
  'readiness_failed',
  'rollback_failed',
  'quota_deferred',
  'install_failed',
  'operation_unknown',
];
const ENGINE_REJECTION_REASONS = new Set([
  'operation_in_progress',
  'rate_limited',
  'target_unavailable',
  'action_blocked',
  'upgrade_unsupported',
  'setup_required',
  'setup_blocked',
  'operation_unknown',
]);
const ENGINE_FAILURE_REASONS = new Set(['install_failed', 'upgrade_failed', 'restart_failed', 'readiness_failed', 'rollback_failed', 'quota_deferred']);
const RUNTIME_STATUS_REQUEST_KEYS = ['channel', 'type', 'requestId'];
const RUNTIME_STATUS_RESPONSE_KEYS = ['channel', 'type', 'requestId', 'frontendMode', 'activeBuildId', 'activeBuildLabel', 'frontendBuildRequired', 'frontendBuildReason'];
const SETUP_CONTROL_KEYS = ['channel', 'type', 'operationId', 'requestedBy'];
const SETUP_COMMIT_KEYS = ['channel', 'type', 'operationId'];
const SETUP_STATUS_REQUEST_KEYS = ['channel', 'type', 'requestId', 'operationId'];
const SETUP_RESPONSE_KEYS = ['channel', 'type', 'operationId', 'status', 'phase', 'reason', 'startedAt', 'completedAt'];
const SETUP_STATUS_RESPONSE_KEYS = ['channel', 'type', 'requestId', 'operation'];
const SETUP_PHASES = ['reserved', 'checking', 'server_dependencies', 'client_dependencies', 'verifying', 'completed', 'failed'];
const SETUP_REASONS = ['operation_in_progress', 'environment_ready', 'setup_blocked', 'active_tasks', 'setup_failed', 'status_unavailable'];

function isBoundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isProtocolVersion(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

export function parseLauncherControlMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== CONTROL_KEYS.length || keys.some((key) => !CONTROL_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-control-v1' || value.type !== 'restart_request') return null;
  if (!['backend', 'frontend', 'relay'].includes(value.target)) return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  if (!isBoundedString(value.requestedBy, 64) || /[\u0000-\u001f\u007f]/.test(value.requestedBy)) return null;
  if (!isProtocolVersion(value.clientProtocolVersion) || !isProtocolVersion(value.serverProtocolVersion)) return null;

  return {
    channel: 'relay-control-v1',
    type: 'restart_request',
    operationId: value.operationId,
    target: value.target,
    requestedBy: value.requestedBy,
    clientProtocolVersion: value.clientProtocolVersion,
    serverProtocolVersion: value.serverProtocolVersion,
  };
}

export function parseLauncherControlCommit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== COMMIT_KEYS.length || keys.some((key) => !COMMIT_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-control-v1' || value.type !== 'restart_commit') return null;
  if (!['backend', 'frontend', 'relay'].includes(value.target)) return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  return {
    channel: 'relay-control-v1',
    type: 'restart_commit',
    operationId: value.operationId,
    target: value.target,
  };
}

export function createLauncherControlResponse(
  request,
  status,
  reason = null,
  retryAfterMs = 0,
  message = null,
) {
  const normalizedMessage = typeof message === 'string'
    ? message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000) || null
    : null;
  return {
    channel: 'relay-control-v1',
    type: 'restart_response',
    operationId: request.operationId,
    target: request.target,
    status,
    reason,
    retryAfterMs,
    message: normalizedMessage,
  };
}

export function parseLauncherControlResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== RESPONSE_KEYS.length || keys.some((key) => !RESPONSE_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-control-v1' || value.type !== 'restart_response') return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  if (!['backend', 'frontend', 'relay'].includes(value.target)) return null;
  if (!RESPONSE_STATUSES.includes(value.status)) return null;
  if (value.reason !== null && !RESPONSE_REASONS.includes(value.reason)) return null;
  if (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0 || value.retryAfterMs > 3_600_000) return null;
  if (value.status === 'rejected' && value.reason === null) return null;
  if (value.status !== 'rejected' && value.reason !== null) return null;
  if (value.reason !== 'rate_limited' && value.retryAfterMs !== 0) return null;
  if (value.message !== null && (!isBoundedString(value.message, 1000) || /[\u0000-\u001f\u007f]/.test(value.message))) return null;
  if (value.status !== 'failed' && value.message !== null) return null;
  return {
    channel: 'relay-control-v1',
    type: 'restart_response',
    operationId: value.operationId,
    target: value.target,
    status: value.status,
    reason: value.reason,
    retryAfterMs: value.retryAfterMs,
    message: value.message,
  };
}

export function parseLauncherStatusRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== STATUS_REQUEST_KEYS.length || keys.some((key) => !STATUS_REQUEST_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-control-v1' || value.type !== 'status_request') return null;
  if (!isBoundedString(value.requestId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.requestId)) return null;
  return { channel: 'relay-control-v1', type: 'status_request', requestId: value.requestId };
}

export function createLauncherStatusResponse(request, cooldowns) {
  return {
    channel: 'relay-control-v1',
    type: 'status_response',
    requestId: request.requestId,
    backendRetryAfterMs: cooldowns.backendRetryAfterMs,
    frontendRetryAfterMs: cooldowns.frontendRetryAfterMs,
    operationInProgress: cooldowns.operationInProgress,
  };
}

export function parseLauncherStatusResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== STATUS_RESPONSE_KEYS.length || keys.some((key) => !STATUS_RESPONSE_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-control-v1' || value.type !== 'status_response') return null;
  if (!isBoundedString(value.requestId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.requestId)) return null;
  for (const key of ['backendRetryAfterMs', 'frontendRetryAfterMs']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 3_600_000) return null;
  }
  if (typeof value.operationInProgress !== 'boolean') return null;
  return {
    channel: 'relay-control-v1',
    type: 'status_response',
    requestId: value.requestId,
    backendRetryAfterMs: value.backendRetryAfterMs,
    frontendRetryAfterMs: value.frontendRetryAfterMs,
    operationInProgress: value.operationInProgress,
  };
}

export function parseLauncherMaintenanceOutputRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== MAINTENANCE_OUTPUT_REQUEST_KEYS.length || keys.some((key) => !MAINTENANCE_OUTPUT_REQUEST_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-maintenance-output-v1' || value.type !== 'output_status_request') return null;
  if (!isBoundedString(value.requestId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.requestId)) return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  return { channel: 'relay-maintenance-output-v1', type: 'output_status_request', requestId: value.requestId, operationId: value.operationId };
}

function parseMaintenanceOutput(value, operationId) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== MAINTENANCE_OUTPUT_KEYS.length || keys.some((key) => !MAINTENANCE_OUTPUT_KEYS.includes(key))) return undefined;
  if (value.operationId !== operationId) return undefined;
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) return undefined;
  if (!Array.isArray(value.lines) || value.lines.length > 2) return undefined;
  if (value.lines.some((line) => !isBoundedString(line, 500) || /[\u0000-\u001f\u007f]/.test(line))) return undefined;
  if (!['running', 'completed', 'failed'].includes(value.status)) return undefined;
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return undefined;
  return { operationId: value.operationId, sequence: value.sequence, lines: [...value.lines], status: value.status, updatedAt: value.updatedAt };
}

export function createLauncherMaintenanceOutputResponse(request, output) {
  return {
    channel: 'relay-maintenance-output-v1',
    type: 'output_status_response',
    requestId: request.requestId,
    operationId: request.operationId,
    output,
  };
}

export function parseLauncherMaintenanceOutputResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== MAINTENANCE_OUTPUT_RESPONSE_KEYS.length || keys.some((key) => !MAINTENANCE_OUTPUT_RESPONSE_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-maintenance-output-v1' || value.type !== 'output_status_response') return null;
  if (!isBoundedString(value.requestId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.requestId)) return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  const output = parseMaintenanceOutput(value.output, value.operationId);
  if (output === undefined) return null;
  return { channel: 'relay-maintenance-output-v1', type: 'output_status_response', requestId: value.requestId, operationId: value.operationId, output };
}

function isEngineAction(engineId, action) {
  return ENGINE_ACTIONS.get(engineId)?.has(action) === true;
}

export function parseLauncherEngineControlMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ENGINE_CONTROL_KEYS.length || keys.some((key) => !ENGINE_CONTROL_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-engine-control-v1' || value.type !== 'engine_request') return null;
  if (!isEngineAction(value.engineId, value.action)) return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  if (!isBoundedString(value.requestedBy, 64) || /[\u0000-\u001f\u007f]/.test(value.requestedBy)) return null;
  if (!Array.isArray(value.workspaceRoots) || value.workspaceRoots.length > 32) return null;
  if (value.workspaceRoots.some((root) => !isBoundedString(root, 1024)
    || /[\u0000-\u001f\u007f]/.test(root)
    || (!/^[A-Za-z]:[\\/]/.test(root) && !root.startsWith('/')))) return null;
  return {
    channel: 'relay-engine-control-v1', type: 'engine_request', operationId: value.operationId,
    engineId: value.engineId, action: value.action, requestedBy: value.requestedBy, workspaceRoots: [...value.workspaceRoots],
  };
}

export function parseLauncherEngineControlCommit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ENGINE_COMMIT_KEYS.length || keys.some((key) => !ENGINE_COMMIT_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-engine-control-v1' || value.type !== 'engine_commit') return null;
  if (!isEngineAction(value.engineId, value.action)) return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  return {
    channel: 'relay-engine-control-v1', type: 'engine_commit', operationId: value.operationId,
    engineId: value.engineId, action: value.action,
  };
}

export function parseLauncherEngineControlAbort(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ENGINE_ABORT_KEYS.length || keys.some((key) => !ENGINE_ABORT_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-engine-control-v1' || value.type !== 'engine_abort') return null;
  if (!isEngineAction(value.engineId, value.action)) return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  return {
    channel: 'relay-engine-control-v1', type: 'engine_abort', operationId: value.operationId,
    engineId: value.engineId, action: value.action,
  };
}

export function createLauncherEngineControlResponse(request, status, reason = null, retryAfterMs = 0) {
  return {
    channel: 'relay-engine-control-v1', type: 'engine_response', operationId: request.operationId,
    engineId: request.engineId, action: request.action, status, reason, retryAfterMs,
  };
}

export function parseLauncherEngineControlResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ENGINE_RESPONSE_KEYS.length || keys.some((key) => !ENGINE_RESPONSE_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-engine-control-v1' || value.type !== 'engine_response') return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  if (!isEngineAction(value.engineId, value.action) || !RESPONSE_STATUSES.includes(value.status)) return null;
  if (value.reason !== null && !ENGINE_RESPONSE_REASONS.includes(value.reason)) return null;
  if (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0 || value.retryAfterMs > 3_600_000) return null;
  if (value.status === 'rejected' && !ENGINE_REJECTION_REASONS.has(value.reason)) return null;
  if (value.status === 'failed' && !ENGINE_FAILURE_REASONS.has(value.reason)) return null;
  if ((value.status === 'accepted' || value.status === 'completed') && value.reason !== null) return null;
  if (value.reason !== 'rate_limited' && value.retryAfterMs !== 0) return null;
  return { ...value };
}

export function parseLauncherRuntimeStatusRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== RUNTIME_STATUS_REQUEST_KEYS.length || keys.some((key) => !RUNTIME_STATUS_REQUEST_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-control-v1' || value.type !== 'runtime_status_request') return null;
  if (!isBoundedString(value.requestId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.requestId)) return null;
  return { channel: 'relay-control-v1', type: 'runtime_status_request', requestId: value.requestId };
}

export function createLauncherRuntimeStatusResponse(request, status) {
  return {
    channel: 'relay-control-v1',
    type: 'runtime_status_response',
    requestId: request.requestId,
    frontendMode: status.frontendMode,
    activeBuildId: status.activeBuildId,
    activeBuildLabel: status.activeBuildLabel,
    frontendBuildRequired: status.frontendBuildRequired,
    frontendBuildReason: status.frontendBuildReason,
  };
}

export function parseLauncherRuntimeStatusResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== RUNTIME_STATUS_RESPONSE_KEYS.length || keys.some((key) => !RUNTIME_STATUS_RESPONSE_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-control-v1' || value.type !== 'runtime_status_response') return null;
  if (!isBoundedString(value.requestId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.requestId)) return null;
  if (!['production', 'development'].includes(value.frontendMode)) return null;
  if (value.activeBuildId !== null && (typeof value.activeBuildId !== 'string' || !/^[a-f0-9]{8,16}$/.test(value.activeBuildId))) return null;
  if (value.activeBuildLabel !== null && (typeof value.activeBuildLabel !== 'string' || !/^\d{8}-\d{4} · [a-f0-9]{7}$/.test(value.activeBuildLabel))) return null;
  if (typeof value.frontendBuildRequired !== 'boolean') return null;
  if (value.frontendBuildReason !== null && (typeof value.frontendBuildReason !== 'string' || value.frontendBuildReason.length > 160 || /[\u0000-\u001f\u007f]/.test(value.frontendBuildReason))) return null;
  if (value.frontendMode === 'development' && (value.activeBuildId !== null || value.activeBuildLabel !== null || value.frontendBuildRequired || value.frontendBuildReason !== null)) return null;
  return {
    channel: 'relay-control-v1',
    type: 'runtime_status_response',
    requestId: value.requestId,
    frontendMode: value.frontendMode,
    activeBuildId: value.activeBuildId,
    activeBuildLabel: value.activeBuildLabel,
    frontendBuildRequired: value.frontendBuildRequired,
    frontendBuildReason: value.frontendBuildReason,
  };
}

export function parseLauncherSetupControlMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== SETUP_CONTROL_KEYS.length || keys.some((key) => !SETUP_CONTROL_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-setup-control-v1' || value.type !== 'setup_request') return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  if (!isBoundedString(value.requestedBy, 64) || /[\u0000-\u001f\u007f]/.test(value.requestedBy)) return null;
  return { channel: 'relay-setup-control-v1', type: 'setup_request', operationId: value.operationId, requestedBy: value.requestedBy };
}

export function parseLauncherSetupControlCommit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== SETUP_COMMIT_KEYS.length || keys.some((key) => !SETUP_COMMIT_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-setup-control-v1' || value.type !== 'setup_commit') return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  return { channel: 'relay-setup-control-v1', type: 'setup_commit', operationId: value.operationId };
}

export function parseLauncherSetupStatusRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== SETUP_STATUS_REQUEST_KEYS.length || keys.some((key) => !SETUP_STATUS_REQUEST_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-setup-control-v1' || value.type !== 'setup_status_request') return null;
  if (!isBoundedString(value.requestId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.requestId)) return null;
  if (value.operationId !== null && (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId))) return null;
  return { channel: 'relay-setup-control-v1', type: 'setup_status_request', requestId: value.requestId, operationId: value.operationId };
}

export function createLauncherSetupStatusResponse(request, operation) {
  return { channel: 'relay-setup-control-v1', type: 'setup_status_response', requestId: request.requestId, operation: operation ? createLauncherSetupResponse(operation) : null };
}

export function parseLauncherSetupStatusResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== SETUP_STATUS_RESPONSE_KEYS.length || keys.some((key) => !SETUP_STATUS_RESPONSE_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-setup-control-v1' || value.type !== 'setup_status_response') return null;
  if (!isBoundedString(value.requestId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.requestId)) return null;
  const operation = value.operation === null ? null : parseLauncherSetupResponse(value.operation);
  if (value.operation !== null && !operation) return null;
  return { channel: 'relay-setup-control-v1', type: 'setup_status_response', requestId: value.requestId, operation };
}

export function createLauncherSetupResponse(operation, status = operation.status) {
  return {
    channel: 'relay-setup-control-v1', type: 'setup_response', operationId: operation.operationId,
    status, phase: operation.phase, reason: operation.reason ?? null,
    startedAt: operation.startedAt ?? null, completedAt: operation.completedAt ?? null,
  };
}

export function parseLauncherSetupResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== SETUP_RESPONSE_KEYS.length || keys.some((key) => !SETUP_RESPONSE_KEYS.includes(key))) return null;
  if (value.channel !== 'relay-setup-control-v1' || value.type !== 'setup_response') return null;
  if (!isBoundedString(value.operationId, 128) || !/^[A-Za-z0-9._-]+$/.test(value.operationId)) return null;
  if (!['accepted', 'rejected', 'running', 'completed', 'failed'].includes(value.status)) return null;
  if (!SETUP_PHASES.includes(value.phase)) return null;
  if (value.reason !== null && !SETUP_REASONS.includes(value.reason)) return null;
  for (const key of ['startedAt', 'completedAt']) if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  if (value.status === 'rejected' && !['operation_in_progress', 'environment_ready', 'setup_blocked', 'active_tasks'].includes(value.reason)) return null;
  if (value.status === 'failed' && !['setup_failed', 'status_unavailable'].includes(value.reason)) return null;
  if (['accepted', 'running', 'completed'].includes(value.status) && value.reason !== null) return null;
  return { ...value };
}
