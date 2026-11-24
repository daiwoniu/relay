import type {
  EngineAdapter,
  EngineConnection,
  EngineConnectionOptions,
} from './adapter.js';
import type { EngineId } from './types.js';
import { connectWithHostContext } from './host-context.js';

export type EngineRegistryErrorCode = 'ENGINE_NOT_REGISTERED' | 'ENGINE_UNAVAILABLE';

export class EngineRegistryError extends Error {
  constructor(
    readonly code: EngineRegistryErrorCode,
    readonly engine: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngineRegistryError';
  }
}

export class EngineRegistry {
  private readonly adapters = new Map<EngineId, EngineAdapter>();

  constructor(adapters: Iterable<EngineAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: EngineAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(engine: EngineId): EngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new EngineRegistryError('ENGINE_NOT_REGISTERED', engine, `引擎 ${engine} 尚未注册`);
    }
    return adapter;
  }

  list(): EngineAdapter[] {
    return [...this.adapters.values()];
  }

  connect(engine: EngineId, options: EngineConnectionOptions): EngineConnection {
    const adapter = this.get(engine);
    const availability = adapter.availability.getCurrent();
    if (options.executionScope === 'feishu' && !adapter.supportsFeishuIsolation) {
      throw new EngineRegistryError('ENGINE_UNAVAILABLE', engine, '此引擎暂不支持飞书隔离会话');
    }
    if (!availability.available) {
      throw new EngineRegistryError(
        'ENGINE_UNAVAILABLE',
        engine,
        availability.message || `引擎 ${engine} 当前不可用`,
      );
    }
    return connectWithHostContext((input) => adapter.runtime.connect(input), options);
  }
}
