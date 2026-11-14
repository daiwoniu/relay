export function observeHistoryPageEnd(
  root: HTMLElement,
  end: Element,
  loadNext: () => void,
  Observer: typeof IntersectionObserver | undefined = globalThis.IntersectionObserver,
  onLoading: (loading: boolean) => void = () => {},
): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let observer: IntersectionObserver | undefined;
  const requestNext = () => {
    if (!active || pending) return;
    pending = true;
    observer?.disconnect();
    onLoading(true);
    timer = setTimeout(() => {
      if (!active) return;
      active = false;
      onLoading(false);
      loadNext();
    }, 500);
  };
  const onScroll = () => {
    if (root.clientHeight > 0 && root.scrollHeight - root.scrollTop - root.clientHeight <= 4) requestNext();
  };
  if (Observer) {
    observer = new Observer((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 1)) requestNext();
    }, {root, rootMargin:'0px', threshold:1});
    observer.observe(end);
  } else {
    root.addEventListener('scroll', onScroll);
    onScroll();
  }
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    observer?.disconnect();
    root.removeEventListener('scroll', onScroll);
    if (pending) onLoading(false);
  };
}
