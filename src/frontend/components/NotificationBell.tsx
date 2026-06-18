import { useEffect, useState, type JSX } from 'react';
import { Link } from '@tanstack/react-router';
import { Bell } from 'lucide-react';

export function NotificationBell(): JSX.Element {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void fetch('/api/users/me/inbox/unread-count', { credentials: 'same-origin' })
        .then(async (r) => (r.ok ? (r.json() as Promise<{ count: number }>) : { count: 0 }))
        .then((data) => {
          if (!cancelled) setUnread(data.count);
        })
        .catch(() => {
          if (!cancelled) setUnread(0);
        });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <Link
      to="/subscriptions"
      aria-label={unread > 0 ? `Subscriptions, ${unread} unread` : 'Subscriptions'}
      title={unread > 0 ? `${unread} new upload${unread === 1 ? '' : 's'}` : 'Subscriptions'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: '9999px',
        position: 'relative',
        color: 'var(--foreground)',
      }}
    >
      <Bell aria-hidden="true" width={20} height={20} strokeWidth={1.5} />
      {unread > 0 ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 9999,
            background: 'var(--accent)',
            color: 'var(--accent-foreground, #fff)',
            fontSize: 10,
            fontWeight: 600,
            lineHeight: '16px',
            textAlign: 'center',
          }}
        >
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </Link>
  );
}
