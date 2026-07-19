import { signOut } from './auth-client';
import { loadAnalytics } from './analytics-loader';

export async function signOutWithAnalyticsReset(): Promise<void> {
  try {
    const { reset } = await loadAnalytics();
    reset();
  } catch {
    // Analytics must never prevent a user from ending their application session.
  }
  await signOut();
}
