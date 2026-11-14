import { useEffect, useState } from 'react';
import { RESOURCE_DELETION_NOTICE_EVENT } from '../../stores/resource-deletion-notice';

export default function ResourceDeletionNotice() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (event: Event) => {
      setMessage((event as CustomEvent<string>).detail);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(null), 5_000);
    };
    window.addEventListener(RESOURCE_DELETION_NOTICE_EVENT, show);
    return () => {
      window.removeEventListener(RESOURCE_DELETION_NOTICE_EVENT, show);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  if (!message) return null;
  return (
    <div role="status" aria-live="polite" className="resource-deletion-notice">{message}</div>
  );
}
