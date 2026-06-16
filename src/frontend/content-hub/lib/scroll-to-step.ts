// Shared step-advance scroll for the compose wizards (book / blog / script).
//
// The wizards are full-height scroll-snap surfaces (`scroll-snap-type: y
// mandatory`) and advance by scrolling the container to the next `#step-*`
// section. The original code did this with `behavior: 'smooth'`, which — only in
// a foreground/visible tab, where the animation actually runs — fired a
// continuous stream of scroll events. DynamicIslandTOC's scroll handler ran
// synchronously on every one of those events (a getBoundingClientRect per
// heading = forced reflow, plus framer-motion re-renders), so the per-event work
// compounded faster than the browser could paint and hung the renderer for tens
// of seconds. That's the "creating one freezes after hitting Enter" report; it
// never reproduced in a hidden tab because no smooth animation runs there.
//
// Fix: jump instantly. `behavior: 'auto'` lands on the next section's snap point
// in a single scroll event — no animation, no event storm, no freeze. Manual
// scrolling stays smooth + snapped (and DynamicIslandTOC's handler is now
// rAF-coalesced as a second line of defense). We also blur the outgoing step's
// focused field so focus doesn't linger on an off-screen input.
export function scrollToStep(container: HTMLElement, el: HTMLElement): void {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && container.contains(active)) {
    active.blur();
  }
  const top =
    el.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;
  container.scrollTo({ top, behavior: 'auto' });
}
