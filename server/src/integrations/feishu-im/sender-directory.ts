import type { Client } from '@larksuiteoapi/node-sdk';
import type { CoreStoragePort } from '../../storage/contracts.js';
import { readFeishuSenderName } from './sdk.js';

export type SenderName = { name: string | null; expiresAt: number; refreshing?: Promise<void> };
type Scope = { botId: string; tenantKey: string };

function senderKey(scope: Scope, senderId: string) {
  return JSON.stringify([scope.botId, scope.tenantKey, senderId]);
}

export class FeishuSenderDirectory {
  private readonly entries = new Map<string, SenderName>();
  private closed = false;

  constructor(private readonly options: {
    port: Pick<CoreStoragePort, 'runFeishuWork'>;
    assertExclusiveWriter: () => Promise<void>;
  }) {}

  current(scope: Scope, senderId: string) {
    return this.entries.get(senderKey(scope, senderId));
  }

  lookup(scope: Scope, senderId: string, loadClient: () => Promise<Pick<Client, 'request'>>, knownName?: string) {
    const key = senderKey(scope, senderId);
    const entry: SenderName = this.entries.get(key) ?? { name: null, expiresAt: 0 };
    entry.name ??= knownName ?? null;
    if (this.closed) return entry;
    this.entries.delete(key);
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry);
    if (entry.refreshing || entry.expiresAt > Date.now()) return entry;
    entry.refreshing = loadClient().then(client => readFeishuSenderName(client, senderId)).catch(() => null)
      .then(async name => {
        const previous = entry.name;
        entry.name = name ?? previous;
        entry.expiresAt = Date.now() + (name ? 15 : 1) * 60_000;
        if (name && name !== previous && !this.closed && this.entries.get(key) === entry) {
          await this.options.assertExclusiveWriter();
          if (!this.closed && this.entries.get(key) === entry) {
            await this.options.port.runFeishuWork({ ...scope, action: 'rememberSenderName', senderId, name });
          }
        }
      }).catch(() => undefined).finally(() => { entry.refreshing = undefined; });
    return entry;
  }

  close() {
    this.closed = true;
    this.entries.clear();
  }
}
