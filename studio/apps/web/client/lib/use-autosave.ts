import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface AutosaveControls {
  // Stops both a scheduled save and the currently active request while
  // preserving the local value. Callers can use this when a higher-level
  // condition (for example, a stale draft) makes further writes unsafe.
  cancelPendingSave: () => void;
}

// Debounced autosave for a single text field. Keeps a local draft, saves it
// after `delay` ms of inactivity, aborts superseded requests, and adopts new
// server values only when there are no unsaved local edits.
export function useAutosave(
  serverValue: string,
  saveFn: (value: string, signal: AbortSignal) => Promise<unknown>,
  delay = 800,
): [string, (v: string) => void, SaveState, AutosaveControls] {
  const [local, setLocal] = useState(serverValue);
  const [state, setState] = useState<SaveState>("idle");
  const lastSaved = useRef(serverValue);
  const localRef = useRef(serverValue);
  const timerRef = useRef<number | undefined>(undefined);
  const inFlight = useRef<AbortController | null>(null);
  const gen = useRef(0);
  // Callers pass saveFn inline, so the debounced timer must read the latest
  // render's version rather than the one captured when typing started.
  const saveFnRef = useRef(saveFn);
  saveFnRef.current = saveFn;

  const cancelPendingSave = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    inFlight.current?.abort();
    inFlight.current = null;
    // Aborting fetch is best-effort. Invalidate the generation as well so a
    // save implementation that ignores AbortSignal cannot update hook state.
    gen.current += 1;
  }, []);

  useEffect(() => {
    if (localRef.current !== lastSaved.current) return;
    if (state === "saving") return;
    if (serverValue === lastSaved.current) return;
    localRef.current = serverValue;
    lastSaved.current = serverValue;
    setLocal(serverValue);
    setState("idle");
  }, [serverValue, state]);

  useEffect(() => () => cancelPendingSave(), [cancelPendingSave]);

  function set(next: string) {
    localRef.current = next;
    setLocal(next);
    cancelPendingSave();
    if (next === lastSaved.current) {
      setState("idle");
      return;
    }
    setState("saving");
    timerRef.current = window.setTimeout(async () => {
      timerRef.current = undefined;
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      const g = ++gen.current;
      try {
        await saveFnRef.current(next, ctrl.signal);
        if (g !== gen.current) return;
        lastSaved.current = next;
        setState("saved");
      } catch {
        if (ctrl.signal.aborted || g !== gen.current) return;
        setState("error");
      } finally {
        if (inFlight.current === ctrl) inFlight.current = null;
      }
    }, delay);
  }

  return [local, set, state, { cancelPendingSave }];
}
