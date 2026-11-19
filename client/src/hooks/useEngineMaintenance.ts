import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {tracker} from '../analytics/tracker';
import {featureAction} from '../analytics/features';
import type { EngineId, EngineMaintenanceAction, EngineMaintenanceOperationDto, EngineMaintenanceResponseDto, EngineMaintenanceStatusDto } from '../generated/relay-contracts';
import { checkEngineMaintenanceLatest, abortEngineMaintenanceOperation, confirmEngineMaintenance, getEngineMaintenance, getEngineMaintenanceOperation, reserveEngineMaintenance } from '../api/engine-maintenance';
import { pollEngineMaintenanceOperation, recoverRememberedEngineMaintenanceOperation, rememberEngineMaintenanceOperation } from '../recovery/engine-maintenance-operation';
import { disconnectMaintenanceOutput, emptyMaintenanceOutputState, receiveMaintenanceOutput } from '../recovery/maintenance-output-state';
import { useEngineModelsStore } from '../stores/engine-models';
import { getEngineConcurrency } from '../api/engine-concurrency';
import { useEngineConcurrencyStore } from '../stores/engine-concurrency';

export function useEngineMaintenance(enabled: boolean, engineId: EngineId) {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<EngineMaintenanceResponseDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<EngineId | null>(null);
  const [pending, setPending] = useState<{ engine: EngineMaintenanceStatusDto; action: EngineMaintenanceAction } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [operation, setOperation] = useState<EngineMaintenanceOperationDto | null>(null);
  const [aborting, setAborting] = useState(false);
  const [operationOutput, setOperationOutput] = useState(emptyMaintenanceOutputState);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const operationAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => operationAbortRef.current?.abort(), []);
  const refresh = useCallback(async () => {
    const controller = new AbortController(); abortRef.current?.abort(); abortRef.current = controller;
    setLoading(true); setError(null);
    try { setSnapshot(await getEngineMaintenance(controller.signal)); }
    catch (next) { if (!(next instanceof Error && next.name === 'AbortError')) setError(next instanceof Error ? next.message : '读取引擎维护状态失败'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { if (enabled) void refresh(); return () => { abortRef.current?.abort(); }; }, [enabled, refresh]);
  const checkLatest = useCallback(async (engineId: EngineId) => {
    setChecking(engineId); setError(null);
    try {
      const next = await checkEngineMaintenanceLatest(engineId);
      setSnapshot((current) => current ? { engines: current.engines.map((engine) => engine.engineId === engineId ? next : engine) as EngineMaintenanceResponseDto['engines'] } : current);
    } catch (next) { setError(next instanceof Error ? next.message : '检查最新版本失败'); }
    finally { setChecking(null); }
  }, []);
  const trackOperation = useCallback(async (reserved: EngineMaintenanceOperationDto, resumed = false) => {
    const controller = new AbortController(); operationAbortRef.current?.abort(); operationAbortRef.current = controller;
    setTracking(true);
    setOperation(resumed ? reserved : { ...reserved, status: 'processing', message: '维护操作正在执行' });
    setOperationOutput(resumed ? receiveMaintenanceOutput(emptyMaintenanceOutputState(), reserved.output) : emptyMaintenanceOutputState());
    try {
      const terminal = await pollEngineMaintenanceOperation({
        signal: controller.signal,
        probe: (signal) => getEngineMaintenanceOperation(reserved.operationId, signal),
        onOperation: (next) => {
          setOperation(next);
          setOperationOutput((current) => receiveMaintenanceOutput(current, next.output));
        },
        onDisconnected: () => setOperationOutput(disconnectMaintenanceOutput),
      });
      if (!terminal) {
        setError('维护操作仍在后台执行，稍后可重新打开面板查看实际版本');
      } else {
        setOperation(terminal);
        if (terminal.status === 'completed') {
          useEngineModelsStore.getState().invalidate(terminal.engineId);
          try {
            const concurrency = await getEngineConcurrency(controller.signal);
            useEngineConcurrencyStore.getState().replaceConcurrencySnapshot(concurrency);
          } catch (next) {
            if (!(next instanceof Error && next.name === 'AbortError')) {
              // 引擎操作已完成；并发快照刷新失败不应覆盖成功结果。
            }
          }
        }
      }
      await refresh();
    } catch (next) {
      if (!(next instanceof Error && next.name === 'AbortError')) setError(next instanceof Error ? next.message : '读取引擎维护结果失败');
    } finally {
      if (operationAbortRef.current === controller) {
        operationAbortRef.current = null;
        setTracking(false);
      }
    }
  }, [refresh]);
  useEffect(() => {
    if (!enabled || !user?.id) return;
    operationAbortRef.current?.abort();
    setTracking(false);
    setOperation(null);
    setOperationOutput(emptyMaintenanceOutputState());
    setError(null);
    const controller = new AbortController();
    const storage = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    void recoverRememberedEngineMaintenanceOperation({
      storage, userId: user.id, engineId,
      probe: getEngineMaintenanceOperation, signal: controller.signal,
    }).then((remembered) => {
      if (controller.signal.aborted || !remembered) return;
      if (remembered.status === 'completed' || remembered.status === 'failed') {
        setOperation(remembered);
        setOperationOutput(receiveMaintenanceOutput(emptyMaintenanceOutputState(), remembered.output));
      } else {
        void trackOperation(remembered, true);
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取维护进度失败');
    });
    return () => { controller.abort(); operationAbortRef.current?.abort(); };
  }, [enabled, engineId, user?.id, trackOperation]);
  const confirm = useCallback(async () => {
    if (!pending) return;
    featureAction('maintenance','confirm','admin');
    setSubmitting(true); setError(null);
    try {
      const capability = pending.engine.actions.find((item) => item.action === pending.action);
      const operation = await reserveEngineMaintenance(pending.engine.engineId, pending.action, capability?.interruptsActiveTasks === true);
      tracker.action({feature:'maintenance',action:pending.action,surface:'admin',engine:pending.engine.engineId,operationId:operation.operationId});
      if (user?.id) rememberEngineMaintenanceOperation(typeof sessionStorage === 'undefined' ? undefined : sessionStorage, user.id, operation);
      await confirmEngineMaintenance(operation.operationId, operation.engineId, operation.action);
      setPending(null);
      void trackOperation(operation);
    } catch (next) { setError(next instanceof Error ? next.message : '提交引擎维护操作失败'); }
    finally { setSubmitting(false); }
  }, [pending, trackOperation, user?.id]);
  const abort = useCallback(async () => {
    if (!operation || operation.status !== 'processing') return;
    tracker.action({feature:'maintenance',action:'abort',surface:'admin',engine:operation.engineId});setAborting(true); setError(null);
    try {
      await abortEngineMaintenanceOperation(operation.operationId);
      // 中止请求已被启动器接受；终态由既有轮询继续接收（杀进程后会走失败回退并回报 failed）。
    } catch (next) { setError(next instanceof Error ? next.message : '中止维护操作失败'); }
    finally { setAborting(false); }
  }, [operation]);
  return { snapshot, loading, checking, pending, submitting, tracking, aborting, operation, operationOutput: operationOutput.snapshot, operationOutputDisconnected: operationOutput.disconnected, error, refresh, checkLatest, request: (engine: EngineMaintenanceStatusDto, action: EngineMaintenanceAction) => {featureAction('maintenance','select_action','admin'); setOperation(null); setOperationOutput(emptyMaintenanceOutputState()); setPending({ engine, action }); }, cancel: () => {featureAction('maintenance','cancel','admin');setPending(null);}, confirm, abort };
}
