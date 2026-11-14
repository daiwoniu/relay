export function createSetupProcessController(dependencies) {
  let activeChild = null;
  const label = dependencies.label || '初始化';

  const run = async (context) => {
    if (activeChild) throw new Error(`已有${label}进程正在运行`);
    const child = dependencies.spawnSetup(context);
    activeChild = child;
    dependencies.onSpawn?.(child, context);
    const outputListeners = [];
    for (const channel of ['stdout', 'stderr']) {
      const stream = child[channel];
      if (!stream || typeof dependencies.onOutput !== 'function') continue;
      const listener = (chunk) => {
        try { dependencies.onOutput(channel, chunk, context); } catch {}
      };
      stream.on('data', listener);
      outputListeners.push(() => stream.off('data', listener));
    }
    let processError = null;
    let cleanupError = null;
    try {
      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve();
          };
          child.once('error', finish);
          child.once('exit', (code, signal) => {
            if (code === 0) finish();
            else {
              const error = new Error(signal ? `${label}被信号 ${signal} 终止` : `${label}退出码 ${code}`);
              if (Number.isSafeInteger(code)) error.exitCode = code;
              finish(error);
            }
          });
        });
      } catch (error) {
        processError = error;
      }
      try {
        await dependencies.cleanupProcess?.(child);
      } catch (error) {
        cleanupError = error;
      }
    } finally {
      for (const removeListener of outputListeners) removeListener();
      if (activeChild === child) activeChild = null;
    }
    if (processError) {
      if (cleanupError) {
        try { dependencies.onCleanupError?.(cleanupError, processError); } catch {}
      }
      throw processError;
    }
    if (cleanupError) throw cleanupError;
  };

  const stop = async () => {
    const child = activeChild;
    if (!child) return false;
    await dependencies.stopProcess(child);
    return true;
  };

  return {
    run,
    stop,
    getActiveChild: () => activeChild,
  };
}
