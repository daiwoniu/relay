export interface AttachmentUploadQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createAttachmentUploadQueue(): AttachmentUploadQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
