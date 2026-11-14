export interface InterruptibleRuntime {
  isRunning: boolean;
  isStopping: boolean;
  interruptPromise: Promise<void> | null;
  engineConnection: { cancel(): Promise<void> } | null;
}

export interface RuntimeInterruptHooks {
  canCancelBeforeConnection?: boolean;
  onStarting(): void;
  onStopped(): void | Promise<void>;
  onFailed(error: Error): void | Promise<void>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function requestRuntimeInterrupt(
  runtime: InterruptibleRuntime,
  hooks: RuntimeInterruptHooks,
): Promise<void> {
  if (!runtime.isRunning) return Promise.resolve();
  if (runtime.interruptPromise) return runtime.interruptPromise;

  runtime.isStopping = true;

  const promise = (async () => {
    hooks.onStarting();
    if (!runtime.engineConnection && !hooks.canCancelBeforeConnection) throw new Error('引擎连接尚未就绪');
    if (runtime.engineConnection) await runtime.engineConnection.cancel();
    if (runtime.isRunning && runtime.isStopping) await hooks.onStopped();
  })().catch(async (error: unknown) => {
    const normalized = toError(error);
    runtime.isStopping = false;
    await hooks.onFailed(normalized);
    throw normalized;
  }).finally(() => {
    if (runtime.interruptPromise === promise) runtime.interruptPromise = null;
  });

  runtime.interruptPromise = promise;
  return promise;
}
