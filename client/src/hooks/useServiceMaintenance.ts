import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkHealth } from '../api/health.ts';
import {
  confirmServiceRecovery,
  getFrontendStatus,
  getRecoveryCapabilities,
  getServiceRecoveryOperationOutput,
  requestServiceRecovery,
  type RecoveryCapabilities,
} from '../api/service-recovery.ts';
import type { ProtocolMismatch } from '../stores/chat.ts';
import { RELAY_PROTOCOL_VERSION } from '../generated/relay-contracts.ts';
import {
  hasRefreshedForMismatch,
  markMismatchRefreshed,
} from '../recovery/recovery-model.ts';
import { pollForRecovery } from '../recovery/recovery-flow.ts';
import {
  presentServiceRestartError,
  type ServiceRestartErrorPresentation,
} from '../recovery/manual-service-restart.ts';
import {
  getServiceMaintenanceCooldownRefreshDelay,
  getServiceMaintenancePolicy,
  type ServiceMaintenanceAction,
} from '../recovery/service-maintenance-policy.ts';
import {
  canIgnoreRecoveryConfirmationError,
  toRecoveryRequestAction,
} from '../recovery/service-maintenance-operation.ts';
import {
  disconnectMaintenanceOutput,
  emptyMaintenanceOutputState,
  receiveMaintenanceOutput,
} from '../recovery/maintenance-output-state.ts';

export interface UseServiceMaintenanceOptions {
  context: 'manual' | 'protocol_mismatch';
  role: 'admin' | 'member';
  mismatch?: ProtocolMismatch | null;
  enabled?: boolean;
  onReconnect?: () => void;
}

export function useServiceMaintenance(options: UseServiceMaintenanceOptions) {
  const enabled = options.enabled ?? true;
  const mismatch = options.mismatch ?? null;
  const [capabilities, setCapabilities] = useState<RecoveryCapabilities | null>(null);
  const [frontendStartedAt, setFrontendStartedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ServiceRestartErrorPresentation | null>(null);
  const [pendingAction, setPendingAction] = useState<ServiceMaintenanceAction | null>(null);
  const [activeAction, setActiveAction] = useState<ServiceMaintenanceAction | null>(null);
  const [operationOutput, setOperationOutput] = useState(emptyMaintenanceOutputState);
  const [capabilitiesFetchedAt, setCapabilitiesFetchedAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const requestSequence = useRef(0);
  const mountedRef = useRef(false);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const flowAbortRef = useRef<AbortController | null>(null);

  const refreshCapabilities = useCallback(async () => {
    const controller = new AbortController();
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = controller;
    const { signal } = controller;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const [next, frontendStatus] = await Promise.all([
        getRecoveryCapabilities(signal),
        getFrontendStatus(signal).catch((statusError) => {
          if (statusError instanceof Error && statusError.name === 'AbortError') throw statusError;
          return null;
        }),
      ]);
      if (mountedRef.current && !signal.aborted && sequence === requestSequence.current) {
        setCapabilities(next);
        setFrontendStartedAt(frontendStatus?.startedAt ?? null);
        setCapabilitiesFetchedAt(Date.now());
        setClock(Date.now());
      }
      return next;
    } catch (nextError) {
      if (mountedRef.current && sequence === requestSequence.current && !(nextError instanceof Error && nextError.name === 'AbortError')) {
        setCapabilities(null);
        setFrontendStartedAt(null);
        setError(presentServiceRestartError(nextError, 'status'));
      }
      return null;
    } finally {
      if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      if (mountedRef.current && sequence === requestSequence.current && !signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setActiveAction(null);
    void refreshCapabilities();
    return () => refreshAbortRef.current?.abort();
  }, [enabled, mismatch?.clientVersion, mismatch?.serverVersion, refreshCapabilities]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequence.current += 1;
      refreshAbortRef.current?.abort();
      flowAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!enabled || (!capabilities?.backendRetryAfterMs && !capabilities?.frontendRetryAfterMs)) return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [enabled, capabilities?.backendRetryAfterMs, capabilities?.frontendRetryAfterMs]);

  useEffect(() => {
    if (!enabled) return;
    const delay = getServiceMaintenanceCooldownRefreshDelay(
      capabilities,
      Math.max(0, Date.now() - capabilitiesFetchedAt),
    );
    if (delay === null) return;
    const timer = window.setTimeout(() => void refreshCapabilities(), delay);
    return () => window.clearTimeout(timer);
  }, [
    capabilities,
    capabilitiesFetchedAt,
    enabled,
    refreshCapabilities,
  ]);

  const serverVersion = capabilities?.serverProtocolVersion ?? mismatch?.serverVersion ?? null;
  const normalizedMismatch = mismatch
    ? { clientVersion: mismatch.clientVersion, serverVersion }
    : null;
  const refreshed = normalizedMismatch && normalizedMismatch.serverVersion !== null && typeof sessionStorage !== 'undefined'
    ? hasRefreshedForMismatch(sessionStorage, normalizedMismatch.clientVersion, normalizedMismatch.serverVersion)
    : false;
  const policy = useMemo(() => getServiceMaintenancePolicy({
    role: options.role,
    mismatch: normalizedMismatch,
    refreshed,
    capabilities,
    loading,
    submitting,
    elapsedMs: Math.max(0, clock - capabilitiesFetchedAt),
  }), [capabilities, capabilitiesFetchedAt, clock, loading, normalizedMismatch, options.role, refreshed, submitting]);

  const performSafeAction = useCallback((action: 'reload_browser' | 'retry_connection') => {
    if (action === 'reload_browser') {
      if (normalizedMismatch?.serverVersion !== null && normalizedMismatch) {
        if (typeof sessionStorage !== 'undefined') {
          markMismatchRefreshed(sessionStorage, normalizedMismatch.clientVersion, normalizedMismatch.serverVersion);
        }
      }
      window.location.reload();
      return;
    }
    if (action === 'retry_connection') {
      if (options.onReconnect) options.onReconnect();
      else window.location.reload();
    }
  }, [normalizedMismatch, options]);

  const requestAction = useCallback((action: ServiceMaintenanceAction) => {
    const actionState = policy.actions[action];
    if (!actionState.visible || !actionState.enabled) return;
    setError(null);
    if (action === 'reload_browser' || action === 'retry_connection') {
      performSafeAction(action);
      return;
    }
    setPendingAction(action);
  }, [performSafeAction, policy.actions]);

  const cancelPendingAction = useCallback(() => setPendingAction(null), []);

  const confirmPendingAction = useCallback(async () => {
    const action = pendingAction;
    const requestActionValue = action ? toRecoveryRequestAction(action) : null;
    if (!action || !requestActionValue) return;
    const actionState = policy.actions[action];
    if (!actionState.visible || !actionState.enabled) {
      setPendingAction(null);
      return;
    }

    setPendingAction(null);
    setActiveAction(action);
    setSubmitting(true);
    setError(null);
    setOperationOutput(emptyMaintenanceOutputState());
    const controller = new AbortController();
    flowAbortRef.current?.abort();
    flowAbortRef.current = controller;
    const initialBackendStartedAt = capabilities?.backendStartedAt ?? null;
    const initialFrontendStartedAt = frontendStartedAt;
    try {
      const clientProtocolVersion = mismatch?.clientVersion ?? RELAY_PROTOCOL_VERSION;
      const response = await requestServiceRecovery(
        requestActionValue,
        clientProtocolVersion,
        controller.signal,
        actionState.interruptsActiveTasks,
      );
      if (response.status === 'reload_required') {
        if (mismatch && typeof sessionStorage !== 'undefined') {
          markMismatchRefreshed(sessionStorage, mismatch.clientVersion, response.serverProtocolVersion);
        }
        window.location.reload();
        return;
      }
      if (response.status === 'retry_connection') {
        if (options.onReconnect) options.onReconnect();
        else window.location.reload();
        return;
      }

      let confirmationUncertain = false;
      try {
        await confirmServiceRecovery(response.operationId, response.target, controller.signal);
      } catch (confirmationError) {
        if (!canIgnoreRecoveryConfirmationError(confirmationError)) throw confirmationError;
        confirmationUncertain = true;
        // 服务可能在确认响应穿过前端网关前已经开始切换。网络断开或 502/503/504
        // 或确认记录已失效，只能说明结果未知，必须观察实例切换后才能判定成功。
      }
      setOperationOutput(emptyMaintenanceOutputState());
      const latestCapabilitiesRef: { current: RecoveryCapabilities | null } = { current: null };
      const result = await pollForRecovery({
        target: response.target,
        clientProtocolVersion,
        signal: controller.signal,
        timeoutMs: response.target === 'setup'
          ? 20 * 60_000
          : response.target === 'relay'
            ? 90_000
            : response.target === 'frontend'
              ? 90_000
              : 30_000,
        intervalMs: response.target === 'setup' ? 1_000 : 500,
        requireExplicitRestartObserved: response.target === 'setup' || confirmationUncertain,
        probe: async (signal) => {
          try {
            const output = await getServiceRecoveryOperationOutput(response.operationId, signal);
            if (mountedRef.current && !signal?.aborted) setOperationOutput((current) => receiveMaintenanceOutput(current, output));
          } catch (outputError) {
            if (outputError instanceof Error && outputError.name === 'AbortError') throw outputError;
            if (mountedRef.current && !signal?.aborted) setOperationOutput(disconnectMaintenanceOutput);
          }
          const health = await checkHealth(signal);
          const next = await getRecoveryCapabilities(signal);
          const nextFrontendStatus = response.target === 'frontend' || response.target === 'relay'
            ? await getFrontendStatus(signal)
            : null;
          latestCapabilitiesRef.current = next;
          if (mountedRef.current && !signal?.aborted) {
            setCapabilities(next);
            if (nextFrontendStatus) setFrontendStartedAt(nextFrontendStatus.startedAt);
          }
          const backendChanged = initialBackendStartedAt !== null
            && next.backendStartedAt !== null
            && next.backendStartedAt !== initialBackendStartedAt;
          const frontendChanged = initialFrontendStartedAt !== null
            && nextFrontendStatus !== null
            && nextFrontendStatus.startedAt !== initialFrontendStartedAt;
          return {
            healthy: health.status === 'ok' && !next.operationInProgress,
            operationInProgress: next.operationInProgress,
            terminalFailure: response.target === 'setup' && next.setupOperation?.status === 'failed',
            serverProtocolVersion: next.serverProtocolVersion,
            restartObserved: response.target === 'setup'
              ? next.setupOperation?.status === 'completed'
              : response.target === 'backend' || response.target === 'relay'
              ? backendChanged
              : response.target === 'frontend'
                ? frontendChanged
                : frontendChanged,
          };
        },
      });
      if (result.status === 'timeout' || result.status === 'failed') {
        setError({
          title: response.target === 'setup'
            ? '环境修复未完成'
            : response.target === 'frontend'
            ? '前端恢复未完成'
            : response.target === 'relay'
              ? 'Relay 完整重启未完成'
            : response.target === 'backend'
              ? '后端恢复未完成'
              : '等待服务恢复超时',
          detail: response.target === 'setup'
            ? '未能确认环境修复成功。请重新检测；如仍异常，请在终端运行 npm run setup 查看完整输出。'
            : response.target === 'frontend'
            ? '未检测到前端实例完成切换。production 构建可能失败且旧前端仍在运行，请查看启动终端后重新检测。'
            : response.target === 'relay'
              ? '未能确认新启动器和全部 Relay 服务恢复。请查看 logs；如仍不可用，请在终端运行 npm run restart。'
            : response.target === 'backend'
              ? '未检测到后端实例完成切换。当前后端可能仍在运行旧代码，请查看启动终端后重新检测。'
              : '服务没有在预期时间内恢复。请查看启动终端，重新检测后再决定是否执行终端重启。',
          showTerminalFallback: true,
        });
        return;
      }
      if (response.target === 'setup') {
        await refreshCapabilities();
        return;
      }
      if (response.target === 'frontend'
        && latestCapabilitiesRef.current?.frontendMode === 'production'
        && latestCapabilitiesRef.current.frontendBuildRequired) {
        setError({
          title: '前端构建未生效',
          detail: '前端实例已经恢复，但 production 构建仍落后于源码。旧构建可能仍在运行，请查看启动终端中的构建或回滚记录。',
          showTerminalFallback: true,
        });
        return;
      }
      if (response.target === 'backend' && options.onReconnect) {
        options.onReconnect();
      } else {
        window.location.reload();
      }
    } catch (nextError) {
      if (!(nextError instanceof Error && nextError.name === 'AbortError')) {
        setError(presentServiceRestartError(nextError, 'restart'));
      }
    } finally {
      if (flowAbortRef.current === controller) flowAbortRef.current = null;
      if (mountedRef.current) {
        setSubmitting(false);
        setActiveAction(null);
      }
    }
  }, [capabilities?.backendStartedAt, frontendStartedAt, mismatch, options, pendingAction, policy.actions, refreshCapabilities]);

  const abortOperation = useCallback(() => {
    refreshAbortRef.current?.abort();
    flowAbortRef.current?.abort();
    flowAbortRef.current = null;
  }, []);

  return {
    context: options.context,
    mismatch: normalizedMismatch,
    serverVersion,
    capabilities,
    frontendStartedAt,
    loading,
    submitting,
    error,
    pendingAction,
    activeAction,
    operationOutput: operationOutput.snapshot,
    operationOutputDisconnected: operationOutput.disconnected,
    policy,
    refreshCapabilities,
    requestAction,
    cancelPendingAction,
    confirmPendingAction,
    abortOperation,
  };
}

export type ServiceMaintenanceController = ReturnType<typeof useServiceMaintenance>;
