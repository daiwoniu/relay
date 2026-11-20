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

interface Transfer<T> {
  promise: Promise<T>;
  abort: () => void;
}

/** Admission stays fast; actual requests serialize separately, including retries. */
export function createAttachmentTransferQueue() {
  const queue = createAttachmentUploadQueue();
  return {
    enqueue<T>(start: () => Transfer<T>): Transfer<T> {
      let cancelled = false;
      let active: Transfer<T> | undefined;
      return {
        promise: queue.enqueue(async () => {
          if (cancelled) throw new DOMException('上传已取消', 'AbortError');
          active = start();
          return active.promise;
        }),
        abort: () => { cancelled = true; active?.abort(); },
      };
    },
  };
}
