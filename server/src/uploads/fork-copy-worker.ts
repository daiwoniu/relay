import { Worker } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { UploadedFileAttachmentDtoSchema, type UploadedFileAttachmentDto } from '../contracts/index.js';
import { canonicalJson } from '../storage/command-boundary.js';
import { ForkUploadCopyInputSchema } from './fork-copy-contract.js';
import type { ForkUploadCopyInput } from './project-uploads.js';

export class ForkCopyError extends Error {
  constructor(readonly code: 'COPY_RESULT_UNKNOWN' | 'COPY_UNCONFIRMED' | 'OVERLOADED' | 'NOT_SUBMITTED') { super(code); }
}
interface Job { digest: string; worker: Worker; result: Promise<UploadedFileAttachmentDto[]>; finished: boolean; touched: number }
/** Write jobs survive HTTP timeouts. Retrying joins the same job or verifies its on-disk content proof after process restart. */
export class ForkUploadCopier {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  private active = 0;
  private readonly activeProjects = new Set<string>();
  constructor(private readonly timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('INVALID_COPY_TIMEOUT');
  }
  async copy(value: ForkUploadCopyInput,options?:{settleOnTimeout:boolean}): Promise<UploadedFileAttachmentDto[]> {
    if (this.closed) throw new ForkCopyError('NOT_SUBMITTED');
    let input: ForkUploadCopyInput, encoded: string;
    try { encoded = canonicalJson(value, 128*1024); input = ForkUploadCopyInputSchema.parse(JSON.parse(encoded)); }
    catch { throw new ForkCopyError('NOT_SUBMITTED'); }
    const resolvedRoot = path.resolve(input.projectPath), projectKey = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
    const key = `${projectKey}\0${input.targetMessageId}`, digest = createHash('sha256').update(encoded).digest('hex');
    for (const [id, job] of this.jobs) if (job.finished && Date.now()-job.touched > 600_000) this.jobs.delete(id);
    let job = this.jobs.get(key);
    if (job && job.digest !== digest) throw new ForkCopyError('COPY_UNCONFIRMED');
    if (!job) {
      if (this.jobs.size >= 64) {
        const evictable = [...this.jobs].filter(([,candidate]) => candidate.finished).sort((a,b) => a[1].touched-b[1].touched)[0];
        if (evictable) this.jobs.delete(evictable[0]); // Disk proof, rather than an unbounded memory cache, owns retry correctness.
      }
      // Project quota checks and copies must not race in two Workers owned by this coordinator.
      if (this.active >= 2 || this.jobs.size >= 64 || this.activeProjects.has(projectKey)) throw new ForkCopyError('OVERLOADED');
      const requestId = randomUUID(); let worker: Worker;
      try { worker = new Worker(new URL('./fork-copy-bootstrap.mjs', import.meta.url), { workerData: { requestId, input },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } }); }
      catch { throw new ForkCopyError('NOT_SUBMITTED'); }
      this.active++; this.activeProjects.add(projectKey);
      let resolve!: (attachments: UploadedFileAttachmentDto[]) => void, reject!: (error: Error) => void;
      const result = new Promise<UploadedFileAttachmentDto[]>((yes,no) => { resolve = yes; reject = no; });
      job = { digest, worker, result, finished: false, touched: Date.now() }; this.jobs.set(key,job);
      const owned = job; let settled = false;
      const finish = (attachments?: UploadedFileAttachmentDto[]) => {
        if (settled) return; settled = true; owned.finished = true; owned.touched = Date.now();
        if (attachments) resolve(attachments); else reject(new ForkCopyError('COPY_UNCONFIRMED'));
      };
      let reply: UploadedFileAttachmentDto[] | undefined, invalidReply = false;
      worker.on('message', (message) => {
        if (message?.requestId !== requestId) return;
        if (reply || invalidReply) return;
        if (message.error) { invalidReply = true; return; }
        try { canonicalJson(message.attachments, 128*1024); reply = z.array(UploadedFileAttachmentDtoSchema.extend({ available: z.literal(true) }).strict()).max(100).parse(message.attachments); }
        catch { invalidReply = true; }
      });
      worker.on('error', () => { invalidReply = true; });
      worker.once('exit', (code) => {
        this.active--; this.activeProjects.delete(projectKey);
        // Only live work is coalesced. A later retry must check the current on-disk proof, including after an error.
        if (this.jobs.get(key) === owned) this.jobs.delete(key);
        finish(code === 0 && !invalidReply ? reply : undefined);
      });
      // A timed-out or disconnected caller does not own the writer's lifetime or its later rejection.
      void result.catch(() => undefined);
    }
    job.touched = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([job.result, new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new ForkCopyError('COPY_RESULT_UNKNOWN')), this.timeoutMs); timer.unref();
    })]); } catch(error){if(options?.settleOnTimeout)await job.worker.terminate();throw error;} finally { if (timer) clearTimeout(timer); }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled([...this.jobs.values()].map((job) => job.result)), new Promise<void>((resolve) => {
      timer = setTimeout(resolve,10_000); timer.unref();
    })]); } finally { if(timer)clearTimeout(timer); }
    await Promise.all([...this.jobs.values()].map(async (job) => { await job.worker.terminate(); }));
    this.jobs.clear();
  }
}
