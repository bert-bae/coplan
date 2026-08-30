import { useEffect, useState } from 'react';
import { duration } from './format.ts';

/** Counts up from a timestamp, so a parked session visibly costs the user
 *  time rather than sitting there looking static. */
export function useElapsed(since?: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  if (!since) return '';
  return duration(now - since);
}
