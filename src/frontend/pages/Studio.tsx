import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { BookOpen, Film, Scissors } from 'lucide-react';
import { useSession } from '../lib/auth-client';
import { Spinner } from '../create/Spinner';
import { VideoPlaceholderIcon } from '../components/Icons';

type RecentProject = {
  id: string;
  title: string | null;
  updated_at: number;
  status: string;
  thumbnail_url: string | null;
};

const STAGE_CARDS: {
  title: string;
  helper: string;
  to?: string;
  href?: string;
  Icon: React.ElementType;
  traceDuration: string;
}[] = [
  {
    title: 'Pre-Production',
    helper: 'Plan, script, and write your project.',
    to: '/words',
    Icon: BookOpen,
    traceDuration: '1.6s',
  },
  {
    title: 'Production',
    helper: 'Generate animations, images, and AI tools.',
    to: '/studio',
    Icon: Film,
    traceDuration: '2s',
  },
  {
    title: 'Post-Production',
    helper: 'Edit, remix, and export your final cut.',
    href: 'https://reel-ez.com/',
    Icon: Scissors,
    traceDuration: '1.8s',
  },
];

function StageCards(): JSX.Element {
  return (
    <section className="stack-sm" aria-label="Production stages">
      <h2 className="ds-h3" style={{ margin: 0, marginBottom: 'var(--space-4)' }}>Your workflow</h2>
      <div className="suggestion-grid">
        {STAGE_CARDS.map((card, i) => {
          const inner = (
            <>
              <span className="suggestion-card__border" aria-hidden="true">
                <span className="suggestion-card__shine" />
              </span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  marginBottom: 'var(--space-2)',
                }}
              >
                <card.Icon size={24} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{card.title}</div>
              <div className="ds-meta" style={{ marginTop: 4 }}>{card.helper}</div>
            </>
          );

          const sharedProps = {
            className: 'suggestion-card suggestion-card--glow',
            style: { '--trace-duration': card.traceDuration } as React.CSSProperties,
          };

          if (card.href) {
            return (
              <a key={i} href={card.href} target="_blank" rel="noopener noreferrer" {...sharedProps}>
                {inner}
              </a>
            );
          }
          return (
            <Link key={i} to={card.to!} {...sharedProps}>
              {inner}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function RecentProjects(): JSX.Element {
  const [projects, setProjects] = useState<RecentProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/studio/projects', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load projects');
        return (await r.json()) as { projects: RecentProject[] };
      })
      .then((data) => {
        if (!cancelled) setProjects(data.projects);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="status-error">{error}</p>;
  if (projects === null) return <p className="ds-meta">Loading projects…</p>;
  if (projects.length === 0) {
    return <p className="ds-empty">No projects yet — start one from a source video.</p>;
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 'var(--space-3)',
      }}
    >
      {projects.map((project) => (
        <div key={project.id} className="suggestion-card">
          {project.thumbnail_url ? (
            <img
              src={project.thumbnail_url}
              alt=""
              loading="lazy"
              decoding="async"
              style={{
                width: '100%',
                aspectRatio: '16/9',
                objectFit: 'cover',
                borderRadius: 8,
                marginBottom: 'var(--space-2)',
              }}
            />
          ) : (
            <VideoPlaceholderIcon />
          )}
          <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>
            {project.title ?? 'Untitled project'}
          </div>
          <div className="ds-meta" style={{ marginTop: 4 }}>
            {new Date(project.updated_at).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Studio(): JSX.Element {
  const location = useLocation();
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in" style={{ padding: 24 }}>
        <Spinner label="Loading session…" />
      </main>
    );
  }
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (session.user.emailVerified === false) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <h1 className="ds-h2">Verify your email to use the studio</h1>
        <p>The AI Studio is unlocked after you confirm your email.</p>
      </main>
    );
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section
        className="stack-sm"
        style={{ paddingTop: 'var(--space-4)', paddingBottom: 'var(--space-2)' }}
      >
        <h1 className="ds-h2">Studio</h1>
        <p className="ds-lede">Your creative workspace — from first draft to final cut.</p>
      </section>

      <StageCards />

      <section className="stack-sm" aria-label="Recent projects">
        <h2 className="ds-h3" style={{ margin: 0 }}>Recent projects</h2>
        <RecentProjects />
      </section>
    </main>
  );
}
