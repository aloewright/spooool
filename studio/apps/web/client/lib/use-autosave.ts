import { useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

// Debounced autosave for a single text field. Keeps a local draft, saves it
// after `delay` ms of inactivity, aborts superseded requests, and adopts new
// server values only when there are no unsaved local edits.
export function useAutosave(
  serverValue: string,
  saveFn: (value: string, signal: AbortSignal) => Promise<unknown>,
  delay = 800,
): [string, (v: string) => void, SaveState] {
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

  useEffect(() => {
    if (localRef.current !== lastSaved.current) return;
    if (state === "saving") return;
    if (serverValue === lastSaved.current) return;
    localRef.current = serverValue;
    lastSaved.current = serverValue;
    setLocal(serverValue);
    setState("idle");
  }, [serverValue, state]);

  useEffect(
    () => () => {
      timerRef.current && clearTimeout(timerRef.current);
      inFlight.current?.abort();
    },
    [],
  );

  function set(next: string) {
    localRef.current = next;
    setLocal(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (next === lastSaved.current) {
      setState("idle");
      return;
    }
    setState("saving");
    timerRef.current = window.setTimeout(async () => {
      inFlight.current?.abort();
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
      }
    }, delay);
  }

  return [local, set, state];
}
