import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { duration } from '../lib/format.ts';

/**
 * While the stream is down every number on screen is stale but still presented
 * as fact. Say so, and after a while stop pretending.
 */
export function ConnectionBar() {
  const connection = useStore((s) => s.connection);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (connection === 'live') {
      setSince(null);
      return;
    }
    setSince((current) => current ?? Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [connection]);

  // The daemon restarted with a new token: nothing here will reconnect it,
  // and saying "reconnecting" forever would be a lie.
  if (connection === 'unauthorized') {
    return (
      <div className="conn-bar" role="alert">
        <span aria-hidden="true">⚠</span>
        <span>
          Coplan restarted and no longer knows this page. Reopen it with <code>coplan open</code> (or <code>/coplan-open</code>) — what
          you see here is out of date and cannot be saved.
        </span>
      </div>
    );
  }

  // A one-second blip should not flash the interface.
  if (connection === 'live' || !since || now - since < 2000) return null;

  return (
    <div className="conn-bar" role="status">
      <span aria-hidden="true">⚠</span>
      <span>
        Reconnecting — last update {duration(now - since)} ago. What you see may be out of date.
      </span>
    </div>
  );
}
