import { useEffect, useState } from 'react';
import { checkHealth } from '../api/health';
import type { ServiceStatus } from '../components/ui/ServiceStatusIndicator';

export function useServiceStatus(intervalMs = 5000): ServiceStatus {
  const [status, setStatus] = useState<ServiceStatus>('checking');

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | null = null;

    const check = async () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 3000);
      try {
        await checkHealth(controller.signal);
        if (!disposed) setStatus('online');
      } catch {
        if (!disposed) setStatus('offline');
      } finally {
        window.clearTimeout(timeout);
      }
    };

    void check();
    const interval = window.setInterval(() => void check(), intervalMs);
    return () => {
      disposed = true;
      activeController?.abort();
      window.clearInterval(interval);
    };
  }, [intervalMs]);

  return status;
}
