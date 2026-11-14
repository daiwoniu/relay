import { parentPort, workerData } from 'node:worker_threads';
import { ProjectUploadStore, UploadError } from './project-uploads.js';
import { ForkUploadCopyInputSchema } from './fork-copy-contract.js';
try {
  const input = ForkUploadCopyInputSchema.parse(workerData.input);
  if (Buffer.byteLength(JSON.stringify(input)) > 128*1024) throw new Error();
  const attachments = new ProjectUploadStore().ensureForkCopy(input);
  parentPort!.postMessage({ requestId: workerData.requestId, attachments });
} catch (error) {
  parentPort!.postMessage({ requestId: workerData.requestId,
    error: error instanceof UploadError && /^[A-Z_]{1,80}$/.test(error.code ?? '') ? error.code : 'UPLOAD_FORK_COPY_UNCONFIRMED' });
}
parentPort!.close();
