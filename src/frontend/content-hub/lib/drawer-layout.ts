// Drawer layout store — ported from
// studio/apps/web/client/lib/drawer-layout.ts for the spooool content-hub.
//
// PATCHED for spooool:
//   - localStorage key renamed from "book-cook-drawer-layout" to
//     "spooool-studio-drawer" so it never collides with leftover state from
//     old book-cook.com sessions in the same browser.
import { useEffect, useState } from 'react';

const KEY = 'spooool-studio-drawer';
type DrawerLayout = { open: boolean; collapsed: boolean; chatOpen: boolean };
const DEFAULT: DrawerLayout = { open: true, collapsed: false, chatOpen: false };

let state: DrawerLayout = DEFAULT;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      state = { ...DEFAULT, ...JSON.parse(raw) };
    } else if (window.matchMedia('(max-width: 1023px)').matches) {
      // Below lg the drawer floats over the page content, so small screens
      // start closed — opening it is an explicit action via the reopen pill.
      state = { ...DEFAULT, open: false };
    }
  } catch {
    // ignore — fallback to default
  }
}

export function setDrawerLayout(patch: Partial<DrawerLayout>): void {
  state = { ...state, ...patch };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }
  for (const fn of listeners) fn();
}

export function useDrawerLayout(): DrawerLayout & {
  setOpen: (open: boolean) => void;
  setCollapsed: (collapsed: boolean) => void;
  setChatOpen: (chatOpen: boolean) => void;
  toggleOpen: () => void;
  toggleCollapsed: () => void;
  toggleChatOpen: () => void;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return {
    ...state,
    setOpen: (open) => setDrawerLayout({ open }),
    setCollapsed: (collapsed) => setDrawerLayout({ collapsed }),
    setChatOpen: (chatOpen) => setDrawerLayout({ chatOpen }),
    toggleOpen: () => setDrawerLayout({ open: !state.open }),
    toggleCollapsed: () => setDrawerLayout({ collapsed: !state.collapsed }),
    toggleChatOpen: () => setDrawerLayout({ chatOpen: !state.chatOpen }),
  };
}
