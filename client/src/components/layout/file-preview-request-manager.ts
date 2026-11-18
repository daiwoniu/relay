import type { RightPanelTab } from '../../stores/chat';

function revokeAccessToken(token: string): void {
  if (typeof fetch === 'undefined') return;
  void fetch('/api/filesystem/revoke-file', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token }),
  }).catch(() => undefined);
}

interface RequestEntry {
  generation: number;
  controller: AbortController;
  accessToken?: string;
  objectUrls: Set<string>;
}

export class FilePreviewRequestManager {
  private readonly entries = new Map<string, RequestEntry>();
  private readonly generations = new Map<string, number>();
  private readonly releaseToken: (token: string) => void;
  private readonly releaseObjectUrl: (url: string) => void;

  constructor(
    releaseToken: (token: string) => void = () => undefined,
    releaseObjectUrl: (url: string) => void = () => undefined,
  ) {
    this.releaseToken = releaseToken;
    this.releaseObjectUrl = releaseObjectUrl;
  }

  begin(tabId: string, options: { retainAccessToken?: boolean; retainObjectUrls?: boolean } = {}): { generation: number; signal: AbortSignal } {
    const previous = this.entries.get(tabId);
    const generation = (this.generations.get(tabId) ?? 0) + 1;
    this.generations.set(tabId, generation);
    const retainedAccessToken = options.retainAccessToken ? previous?.accessToken : undefined;
    const retainedUrls = options.retainObjectUrls ? new Set(previous?.objectUrls) : new Set<string>();
    if (previous && options.retainObjectUrls) previous.objectUrls.clear();
    if (previous) this.disposeEntry(previous, { releaseAccessToken: !options.retainAccessToken });
    const entry: RequestEntry = {
      generation,
      controller: new AbortController(),
      objectUrls: retainedUrls,
      ...(retainedAccessToken ? { accessToken: retainedAccessToken } : {}),
    };
    this.entries.set(tabId, entry);
    return { generation, signal: entry.controller.signal };
  }

  isCurrent(tabId: string, generation: number): boolean {
    const entry = this.entries.get(tabId);
    return Boolean(entry && entry.generation === generation && !entry.controller.signal.aborted);
  }

  replaceObjectUrls(tabId: string, generation: number, nextUrl?: string): void {
    const entry = this.entries.get(tabId);
    if (!entry || entry.generation !== generation) return;
    for (const url of entry.objectUrls) if (url !== nextUrl) this.releaseObjectUrl(url);
    entry.objectUrls.clear();
    if (nextUrl) entry.objectUrls.add(nextUrl);
  }

  getSignal(tabId: string): AbortSignal | undefined {
    return this.entries.get(tabId)?.controller.signal;
  }

  trackAccessToken(tabId: string, generation: number, token: string): boolean {
    const entry = this.entries.get(tabId);
    if (!entry || entry.generation !== generation || entry.controller.signal.aborted) return false;
    if (entry.accessToken && entry.accessToken !== token) this.releaseToken(entry.accessToken);
    entry.accessToken = token;
    return true;
  }

  trackObjectUrl(tabId: string, generation: number, url: string): boolean {
    const entry = this.entries.get(tabId);
    if (!entry || entry.generation !== generation || entry.controller.signal.aborted) return false;
    entry.objectUrls.add(url);
    return true;
  }

  dispose(tabId: string): boolean {
    const entry = this.entries.get(tabId);
    if (!entry) return false;
    this.entries.delete(tabId);
    this.disposeEntry(entry);
    return true;
  }

  disposeAll(): void {
    for (const tabId of [...this.entries.keys()]) this.dispose(tabId);
  }

  private disposeEntry(entry: RequestEntry, options: { releaseAccessToken?: boolean } = {}): void {
    entry.controller.abort();
    if (entry.accessToken && options.releaseAccessToken !== false) this.releaseToken(entry.accessToken);
    for (const url of entry.objectUrls) this.releaseObjectUrl(url);
  }
}

export const filePreviewRequestManager = new FilePreviewRequestManager(
  revokeAccessToken,
  (url) => URL.revokeObjectURL(url),
);

export function disposeFilePreviewTab(tab: RightPanelTab): void {
  const managed = filePreviewRequestManager.dispose(tab.id);
  if (!managed && tab.fileAccessToken) revokeAccessToken(tab.fileAccessToken);
  if (!managed && tab.documentPreview?.type === 'pdf-document') URL.revokeObjectURL(tab.documentPreview.previewUrl);
  if (!managed && tab.mediaPreview) URL.revokeObjectURL(tab.mediaPreview.previewUrl);
}
