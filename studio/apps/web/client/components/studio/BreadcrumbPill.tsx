import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

const TIMER_SECONDS = 25 * 60;

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function localTime() {
  return new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// The sprint timer suits book drafting sessions; blog pages pass
// showTimer={false} for a calmer pill of just title and clock.
export function BreadcrumbPill({
  title,
  showTimer = true,
}: { title: string; showTimer?: boolean }) {
  const [remaining, setRemaining] = useState(TIMER_SECONDS);
  const [time, setTime] = useState(localTime);

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining((s) => (s > 0 ? s - 1 : 0));
      setTime(localTime());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="-translate-x-1/2 fixed top-4 left-1/2 z-20 flex max-w-[calc(100vw-2rem)] items-center gap-2 whitespace-nowrap rounded-full bg-neutral-950/90 px-4 py-2 text-neutral-200 text-sm shadow-lg ring-1 ring-white/5 backdrop-blur">
      <span className="truncate font-medium">{title}</span>
      {showTimer && (
        <>
          <span className="text-neutral-600">·</span>
          <span className="font-mono text-red-400 tabular-nums">{fmt(remaining)}</span>
          <button
            aria-label="Restart timer"
            className="grid size-5 place-items-center rounded-full text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
            onClick={() => setRemaining(TIMER_SECONDS)}
            title="Restart timer"
            type="button"
          >
            <RotateCcw className="size-3" />
          </button>
        </>
      )}
      <span className="hidden text-neutral-600 sm:inline">·</span>
      <span className="hidden text-neutral-400 tabular-nums sm:inline">{time}</span>
    </div>
  );
}
