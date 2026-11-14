const RESOURCE_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,119}$/;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface EngineConcurrencyResource {
  resourceKey: string;
  providerKey: string | null;
  label: string;
  defaultMaxActiveTurns: number;
}

export interface EngineConcurrencyContext {
  sessionId: string;
  projectId: string;
}

export function validateEngineConcurrencyResource(input: EngineConcurrencyResource): EngineConcurrencyResource {
  const label = input.label.trim();
  if (!RESOURCE_KEY_PATTERN.test(input.resourceKey)) {
    throw new Error('引擎并发资源键格式无效');
  }
  if (input.providerKey !== null && !PROVIDER_KEY_PATTERN.test(input.providerKey)) {
    throw new Error('引擎 Provider 键格式无效');
  }
  if (!label || label.length > 80) {
    throw new Error('引擎并发资源标签格式无效');
  }
  if (!Number.isSafeInteger(input.defaultMaxActiveTurns)
    || input.defaultMaxActiveTurns < 1
    || input.defaultMaxActiveTurns > 32) {
    throw new Error('引擎默认并发上限必须为 1 到 32 的整数');
  }
  return { ...input, label };
}
