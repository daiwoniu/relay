import { useEffect } from 'react';
import { tracker,type Page } from './tracker';
import { attachAnalyticsLifecycle } from './lifecycle';

export default function PageTracker({ page, locationKey, userId }: { page?: Page | null; locationKey: string; userId: string }) {
  useEffect(() => {
    if (page !== undefined) tracker.page(page, locationKey, userId);
  }, [page, locationKey, userId]);
  useEffect(()=>attachAnalyticsLifecycle(tracker,window,document),[]);
  return null;
}
