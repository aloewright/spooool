// Generic beat-distribution shared by the blog series planner and the script
// scene planner. Maps a structure's narrative beats onto `count` planned
// slots: one beat per slot when the count allows (extra slots continue their
// beat); when there are fewer slots than beats, each slot covers a contiguous
// group of beats. An empty beat list produces untitled slots.

export type PlannedBeat = {
  title: string;
  summary: string;
};

export function distributeBeats(beats: PlannedBeat[], count: number): PlannedBeat[] {
  if (beats.length === 0 || count < 1) {
    return Array.from({ length: Math.max(count, 0) }, () => ({ title: "", summary: "" }));
  }
  if (count >= beats.length) {
    return Array.from({ length: count }, (_, i) => {
      const idx = Math.floor((i * beats.length) / count);
      const prevIdx = i > 0 ? Math.floor(((i - 1) * beats.length) / count) : -1;
      const beat = beats[idx];
      return {
        title: idx === prevIdx ? `${beat.title} (continued)` : beat.title,
        summary: beat.summary,
      };
    });
  }
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor((i * beats.length) / count);
    const end = Math.floor(((i + 1) * beats.length) / count);
    const group = beats.slice(start, end);
    return {
      title: group.map((b) => b.title).join(" · "),
      summary: group.map((b) => b.summary).join(" "),
    };
  });
}
