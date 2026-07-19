export function loadAnalytics(): Promise<typeof import('./analytics')> {
  return import('./analytics');
}
