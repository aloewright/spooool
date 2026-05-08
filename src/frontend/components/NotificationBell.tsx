// ALO-157: header bell + unread badge. Polls the unread-count endpoint on
// mount and on a slow interval (60s) so the badge stays roughly fresh
// without hammering the worker. Clicking the bell opens a small popover
// with the most recent inbox items; on open we mark everything as seen so
// the badge clears.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

const POLL_INTERVAL_MS = 60_000;
const ITEMS_LIMIT = 8;

interface InboxItem {
  video_id: string;
  channel_user_id: string;
  added_at: string;
  seen_at: string | null;
  title: string;
  thumbnail_url: string | null;
  channel_name: string | null;
  channel_username: string | null;
}

interface UnreadResponse {
  unread: number;
  capped: boolean;
}

function BellIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function NotificationBell(): JSX.Element {
  const [unread, setUnread] = useState<{ count: number; capped: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const fetchUnread = useCallback(async () => {
    try {
      const r = await fetch('/api/users/me/notifications/unread-count', {
        credentials: 'same-origin',
      });
      if (!r.ok) return;
      const data = (await r.json()) as UnreadResponse;
      setUnread({ count: data.unread, capped: data.capped });
    } catch {
      // Silent — the badge is best-effort.
    }
  }, []);

  useEffect(() => {
    void fetchUnread();
    const id = window.setInterval(() => void fetchUnread(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [fetchUnread]);

  // Close popover when clicking outside / pressing Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openPopover = useCallback(async () => {
    setOpen(true);
    setLoading(true);
    try {
      const r = await fetch(`/api/users/me/inbox?limit=${ITEMS_LIMIT}`, {
        credentials: 'same-origin',
      });
      if (r.ok) {
        const data = (await r.json()) as { items: InboxItem[] };
        setItems(data.items);
      } else {
        setItems([]);
      }
      // Mark everything seen so the badge clears immediately. Best-effort —
      // if the call fails the next poll catches up.
      void fetch('/api/users/me/inbox/seen', {
        method: 'POST',
        credentials: 'same-origin',
      })
        .then(() => setUnread({ count: 0, capped: false }))
        .catch(() => {});
    } finally {
      setLoading(false);
    }
  }, []);

  const badgeText =
    unread === null || unread.count === 0
      ? null
      : unread.capped
        ? '99+'
        : String(unread.count);

  return (
    <div ref={popoverRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label={`Notifications${badgeText ? ` (${badgeText} unread)` : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            void openPopover();
          }
        }}
        style={{ position: 'relative' }}
      >
        <BellIcon />
        {badgeText ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 8,
              background: 'var(--accent, #d33)',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '16px',
              textAlign: 'center',
              boxShadow: '0 0 0 2px var(--background, #fff)',
            }}
          >
            {badgeText}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 320,
            maxHeight: 420,
            overflow: 'auto',
            background: 'var(--card, #fff)',
            color: 'var(--card-foreground, inherit)',
            border: '1px solid var(--border, #e5e5e5)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
            zIndex: 50,
          }}
        >
          <div
            style={{
              padding: '10px 12px',
              borderBottom: '1px solid var(--border, #eee)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <strong style={{ fontSize: 13 }}>Notifications</strong>
            <Link
              to="/settings/account#notifications"
              className="ds-meta"
              onClick={() => setOpen(false)}
              style={{ textDecoration: 'none' }}
            >
              Settings
            </Link>
          </div>
          {loading ? (
            <div className="ds-meta" style={{ padding: 12 }}>
              Loading…
            </div>
          ) : items === null || items.length === 0 ? (
            <div className="ds-meta" style={{ padding: 12 }}>
              Nothing new from your subscriptions yet.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {items.map((item) => (
                <li key={item.video_id} style={{ borderBottom: '1px solid var(--border, #f3f3f3)' }}>
                  <Link
                    to={`/watch/${item.video_id}`}
                    onClick={() => setOpen(false)}
                    style={{
                      display: 'flex',
                      gap: 8,
                      padding: 10,
                      textDecoration: 'none',
                      color: 'inherit',
                    }}
                  >
                    {item.thumbnail_url ? (
                      <img
                        src={item.thumbnail_url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        style={{
                          width: 64,
                          height: 36,
                          objectFit: 'cover',
                          borderRadius: 4,
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 64,
                          height: 36,
                          background: 'var(--muted, #f3f3f3)',
                          borderRadius: 4,
                          flexShrink: 0,
                        }}
                        aria-hidden="true"
                      />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 13,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.title}
                      </div>
                      <div className="ds-meta">{item.channel_name ?? item.channel_username ?? 'Unknown channel'}</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
