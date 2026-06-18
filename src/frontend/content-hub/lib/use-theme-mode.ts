// Dark-mode detector — ported verbatim from
// studio/apps/web/client/lib/use-theme-mode.ts for the spooool content-hub.
// (No spooool-specific changes; pure React, no imports beyond `react`.)
//
// Observes the `dark` class on <html> and reports whether the studio scope is
// in dark mode, so the BlockNote editors can pick the matching BlockNote theme.
import { useEffect, useState } from 'react';

export function useDarkMode(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document === 'undefined' ? false : document.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}
