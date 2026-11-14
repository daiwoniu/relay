import type { MessageDetailsDto } from '../../generated/relay-contracts';

type DetailsRequest = (sessionId: string, messageId: string) => Promise<MessageDetailsDto>;

interface QueueEntry {
  key: string;
  epoch: number;
  sessionId: string;
  messageId: string;
  request: DetailsRequest;
  resolve: (value: MessageDetailsDto) => void;
  reject: (error: unknown) => void;
}

export class MessageDetailsController {
  private readonly inflight = new Map<string, Promise<MessageDetailsDto>>();
  private readonly resolved = new Map<string, MessageDetailsDto>();
  private readonly queue: QueueEntry[] = [];
  private activeCount = 0;
  private readonly concurrency: number;
  private epoch = 0;

  constructor(concurrency = 2) {
    this.concurrency = concurrency;
  }

  load(sessionId: string, messageId: string, request: DetailsRequest): Promise<MessageDetailsDto> {
    const key = `${this.epoch}:${sessionId}:${messageId}`;
    const cached = this.resolved.get(key);
    if (cached) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running) return running;

    const promise = new Promise<MessageDetailsDto>((resolve, reject) => {
      this.queue.push({ key, epoch: this.epoch, sessionId, messageId, request, resolve, reject });
      this.drain();
    });
    this.inflight.set(key, promise);
    return promise;
  }

  peek(sessionId: string, messageId: string): MessageDetailsDto | undefined {
    return this.resolved.get(`${this.epoch}:${sessionId}:${messageId}`);
  }

  clear(): void {
    this.epoch += 1;
    this.resolved.clear();
    for (const entry of this.queue.splice(0)) entry.reject(new DOMException('详情缓存已清理', 'AbortError'));
    this.inflight.clear();
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.activeCount += 1;
      void entry.request(entry.sessionId, entry.messageId).then((details) => {
        if (entry.epoch === this.epoch) this.resolved.set(entry.key, details);
        entry.resolve(details);
      }, entry.reject).finally(() => {
        this.activeCount -= 1;
        this.inflight.delete(entry.key);
        this.drain();
      });
    }
  }
}

export const messageDetailsController = new MessageDetailsController(2);
