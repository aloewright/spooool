import { useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';

// ALO-151: lazy chip strip for /watch. Renders nothing until the tags
// arrive (or if the server returns an empty list) so it never reserves
// vertical space for a video that has no tags.

interface TagRow {
  slug: string;
  label: string;
}

export function VideoTags({ videoId }: { videoId: string }): JSX.Element | null {
  const [tags, setTags] = useState<TagRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTags(null);
    void fetch(`/api/videos/${encodeURIComponent(videoId)}/tags`)
      .then(async (r) => (r.ok ? ((await r.json()) as { tags: TagRow[] }) : { tags: [] }))
      .then((data) => {
        if (!cancelled) setTags(data.tags);
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  if (tags === null || tags.length === 0) return null;

  return (
    <div
      className="row"
      aria-label="Video tags"
      style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}
    >
      {tags.map((t) => (
        <Link key={t.slug} to={`/tag/${encodeURIComponent(t.slug)}`} className="badge">
          #{t.label}
        </Link>
      ))}
    </div>
  );
}
