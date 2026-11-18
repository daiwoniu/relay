import { useCallback, useEffect, useRef, useState } from 'react';
import { listTrashProjectSessions } from '../../api/trash';
import type { TrashSessionDto } from '../../generated/relay-contracts';

export const TRASH_PROJECT_PAGE_SIZE = 10;
type Page = { items: TrashSessionDto[]; total: number; nextOffset: number; loading: boolean; error?: string };

export function useTrashProjectPages(open: boolean, scope: string) {
  const [pages, setPages] = useState<Record<string, Page>>({});
  const current = useRef<Record<string, Page>>({});
  const requests = useRef(new Map<string, symbol>());
  const update = (next: Record<string, Page>) => { current.current = next; setPages(next); };
  const reset = useCallback(() => { requests.current.clear(); current.current = {}; setPages({}); }, []);
  useEffect(() => { reset(); return () => { requests.current.clear(); }; }, [open, scope, reset]);

  const loadMore = async (id: string) => {
    const prior = current.current[id];
    if (prior?.loading || (prior && !prior.error && prior.nextOffset >= prior.total)) return;
    const token = Symbol(id), offset = prior?.nextOffset ?? 0;
    requests.current.set(id, token);
    update({ ...current.current, [id]: { items: prior?.items ?? [], total: prior?.total ?? 0, nextOffset: offset, loading: true } });
    try {
      const response = await listTrashProjectSessions(id, TRASH_PROJECT_PAGE_SIZE, offset);
      if (requests.current.get(id) !== token) return;
      const items = [...new Map([...(prior?.items ?? []), ...response.items].map(item => [item.id, item])).values()];
      update({ ...current.current, [id]: { items, total: response.total,
        nextOffset: response.items.length ? offset + response.items.length : response.total, loading: false } });
    } catch (cause) {
      if (requests.current.get(id) !== token) return;
      update({ ...current.current, [id]: { items: prior?.items ?? [], total: prior?.total ?? 0, nextOffset: offset,
        loading: false, error: cause instanceof Error ? cause.message : '加载项目会话失败' } });
    } finally { if (requests.current.get(id) === token) requests.current.delete(id); }
  };
  const toggle = (project: { id: string }) => {
    if (project.id in current.current) {
      requests.current.delete(project.id);
      const next = { ...current.current }; delete next[project.id]; update(next);
    } else { void loadMore(project.id); }
  };
  return { pages, toggle, loadMore, reset };
}
