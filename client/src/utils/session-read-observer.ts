import { canAcknowledgeSessionResult } from './session-read-policy.ts';

interface ObserverEnvironment {
  document: Document;
  window: Window;
  IntersectionObserver?: typeof IntersectionObserver;
  MutationObserver?: typeof MutationObserver;
  escape?: (value: string) => string;
}

export function observeSessionResult(resultId: string, send: () => boolean, environment: ObserverEnvironment = {
  document, window, IntersectionObserver: globalThis.IntersectionObserver,
  MutationObserver: globalThis.MutationObserver, escape: globalThis.CSS?.escape,
}): () => void {
  const { document: doc, window: win, IntersectionObserver: Intersection, MutationObserver: Mutation, escape } = environment;
  if (!Intersection || !Mutation || !escape) return () => {};
  let element: Element | null = null;
  let intersecting = false;
  let sent = false;
  let disposed = false;
  const acknowledge = () => {
    if (!disposed && !sent && element?.isConnected && canAcknowledgeSessionResult(doc.visibilityState === 'visible', doc.hasFocus(), intersecting)) {
      sent = send();
    }
  };
  const observer = new Intersection((entries) => {
    for (const entry of entries) if (entry.target === element) intersecting = entry.isIntersecting;
    acknowledge();
  });
  const attach = () => {
    const next = doc.querySelector(`[data-message-id="${escape(resultId)}"]`);
    if (next === element) return;
    if (element) observer.unobserve(element);
    element = next;
    intersecting = false;
    if (element) observer.observe(element);
  };
  // 已连接的节点无需重复查找；React 替换节点后重新绑定，避免静默漏记已读。
  const mutation = new Mutation(() => { if (!disposed && !element?.isConnected) attach(); });
  mutation.observe(doc.body, { childList: true, subtree: true });
  attach();
  doc.addEventListener('visibilitychange', acknowledge);
  win.addEventListener('focus', acknowledge);
  return () => {
    disposed = true;
    observer.disconnect();
    mutation.disconnect();
    doc.removeEventListener('visibilitychange', acknowledge);
    win.removeEventListener('focus', acknowledge);
  };
}
