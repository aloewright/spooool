import { useEffect, useRef } from 'react';
import { useSession } from '../lib/auth-client';
import { loadAnalytics } from '../lib/analytics-loader';

export function AnalyticsIdentity(): null {
  const { data: session, isPending } = useSession();
  const userId = session?.user?.id;
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (isPending) return;
    let cancelled = false;

    if (userId) {
      identifiedUserId.current = userId;
      void loadAnalytics()
        .then(({ identify }) => {
          if (!cancelled) identify(userId);
        })
        .catch(() => undefined);
    } else {
      identifiedUserId.current = null;
      void loadAnalytics()
        .then(({ reset }) => {
          if (!cancelled) reset();
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [isPending, userId]);

  return null;
}
