import { useEffect } from 'react';
import { useSession } from '../lib/auth-client';

export function AnalyticsIdentity(): null {
  const { data: session } = useSession();
  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) return;
    void import('../lib/analytics')
      .then(({ identify }) => identify(userId))
      .catch(() => undefined);
  }, [userId]);

  return null;
}
