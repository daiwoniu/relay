export interface KvConfigOptions {
  allowedKeys?: ReadonlySet<string>;
  source?: string;
}
export function parseKvConfig(content: string, options?: KvConfigOptions): Map<string, string>;
export interface LoadedKvConfig {
  values: Map<string, string>;
  sources: Map<string, string>;
}
export function loadKvConfig(filePath: string, options?: Omit<KvConfigOptions, 'source'> & { required?: boolean }): LoadedKvConfig | null;
