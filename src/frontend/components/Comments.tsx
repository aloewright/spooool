import { useCallback, useEffect, useState, type JSX } from 'react';
import { Link } from '@tanstack/react-router';
import { useSession } from '../lib/auth-client';
import { ReportButton } from './ReportButton';

interface Reply {
  id: string;
  body: string;
  user_id: string;
  author_name: string | null;
  author_username: string | null;
  parent_comment_id: string | null;
  created_at: string;
  updated_at: string;
  edited: boolean;
}

interface CommentNode extends Omit<Reply, 'parent_comment_id'> {
  parent_comment_id: null;
  reply_count: number;
  replies: Reply[];
}

type Sort = 'new' | 'top';

interface ApiResponse {
  comments: CommentNode[];
  page: number;
  limit: number;
  sort: Sort;
}

function timeAgo(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    return `${Math.round(diffSec / 86400)}d ago`;
  } catch {
    return '';
  }
}

function AuthorLine({
  authorUsername,
  authorName,
  createdAt,
  edited,
}: {
  authorUsername: string | null;
  authorName: string | null;
  createdAt: string;
  edited: boolean;
}): JSX.Element {
  return (
    <div className="ds-meta">
      {authorUsername ? (
        <Link to="/channel/$username" params={{ username: authorUsername }} style={{ fontWeight: 600 }}>
          @{authorUsername}
        </Link>
      ) : (
        <span style={{ fontWeight: 600 }}>{authorName ?? 'unknown'}</span>
      )}
      {' · '}
      {timeAgo(createdAt)}
      {edited ? ' · edited' : ''}
    </div>
  );
}

export function Comments({ videoId }: { videoId: string }): JSX.Element {
  const { data: session } = useSession();
  const [sort, setSort] = useState<Sort>('new');
  const [comments, setComments] = useState<CommentNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyOpen, setReplyOpen] = useState<Record<string, boolean>>({});
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const r = await fetch(
        `/api/videos/${encodeURIComponent(videoId)}/comments?sort=${sort}`,
        { credentials: 'same-origin' },
      );
      if (!r.ok) throw new Error('Failed to load comments');
      const data = (await r.json()) as ApiResponse;
      setComments(data.comments);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load comments');
    }
  }, [videoId, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitTopLevel = async (): Promise<void> => {
    if (!session) {
      setError('Sign in to comment.');
      return;
    }
    const body = draft.trim();
    if (body.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/videos/${encodeURIComponent(videoId)}/comments`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) {
        const err = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? 'Failed to post comment');
      }
      setDraft('');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to post comment');
    } finally {
      setBusy(false);
    }
  };

  const submitReply = async (parentId: string): Promise<void> => {
    if (!session) {
      setError('Sign in to reply.');
      return;
    }
    const body = (replyDrafts[parentId] ?? '').trim();
    if (body.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/videos/${encodeURIComponent(videoId)}/comments`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, parentCommentId: parentId }),
      });
      if (!r.ok) {
        const err = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? 'Failed to post reply');
      }
      setReplyDrafts((d) => ({ ...d, [parentId]: '' }));
      setReplyOpen((d) => ({ ...d, [parentId]: false }));
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to post reply');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (commentId: string): Promise<void> => {
    const body = editDraft.trim();
    if (body.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/comments/${encodeURIComponent(commentId)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error('Failed to edit comment');
      setEditId(null);
      setEditDraft('');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to edit comment');
    } finally {
      setBusy(false);
    }
  };

  const deleteComment = async (commentId: string): Promise<void> => {
    if (!window.confirm('Delete this comment?')) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/comments/${encodeURIComponent(commentId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error('Failed to delete comment');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to delete comment');
    } finally {
      setBusy(false);
    }
  };

  const myId = session?.user?.id;

  return (
    <section className="stack-sm" aria-label="Comments">
      <header className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="ds-label">Comments</span>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button
            type="button"
            className={sort === 'new' ? 'btn btn--secondary btn--sm' : 'btn btn--ghost btn--sm'}
            onClick={() => setSort('new')}
          >
            New
          </button>
          <button
            type="button"
            className={sort === 'top' ? 'btn btn--secondary btn--sm' : 'btn btn--ghost btn--sm'}
            onClick={() => setSort('top')}
          >
            Top
          </button>
        </div>
      </header>

      {session ? (
        <div className="stack-sm">
          <textarea
            className="input"
            placeholder="Add a comment…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
          />
          <div>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                void submitTopLevel();
              }}
              disabled={busy || draft.trim().length === 0}
            >
              Post
            </button>
          </div>
        </div>
      ) : (
        <p className="ds-meta">
          <Link to="/login">Sign in</Link> to comment.
        </p>
      )}

      {error ? <p className="status-error">{error}</p> : null}

      {comments === null ? (
        <p className="ds-meta">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="ds-meta">No comments yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack-sm">
          {comments.map((c) => (
            <li key={c.id} className="card--tight stack-sm" style={{ padding: 'var(--space-3)' }}>
              <AuthorLine
                authorUsername={c.author_username}
                authorName={c.author_name}
                createdAt={c.created_at}
                edited={c.edited}
              />
              {editId === c.id ? (
                <div className="stack-sm">
                  <textarea
                    className="input"
                    rows={3}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                  />
                  <div className="row" style={{ gap: 'var(--space-2)' }}>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy || editDraft.trim().length === 0}
                      onClick={() => {
                        void saveEdit(c.id);
                      }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        setEditId(null);
                        setEditDraft('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>
              )}
              <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setReplyOpen((d) => ({ ...d, [c.id]: !d[c.id] }))}
                >
                  Reply
                </button>
                {myId === c.user_id && editId !== c.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        setEditId(c.id);
                        setEditDraft(c.body);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        void deleteComment(c.id);
                      }}
                    >
                      Delete
                    </button>
                  </>
                ) : myId !== c.user_id ? (
                  <ReportButton targetType="comment" targetId={c.id} />
                ) : null}
                {c.reply_count > 0 ? (
                  <span className="ds-meta">{c.reply_count} replies</span>
                ) : null}
              </div>

              {replyOpen[c.id] && session ? (
                <div className="stack-sm" style={{ marginLeft: 'var(--space-4)' }}>
                  <textarea
                    className="input"
                    rows={2}
                    placeholder="Reply…"
                    value={replyDrafts[c.id] ?? ''}
                    onChange={(e) =>
                      setReplyDrafts((d) => ({ ...d, [c.id]: e.target.value }))
                    }
                  />
                  <div>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy || (replyDrafts[c.id] ?? '').trim().length === 0}
                      onClick={() => {
                        void submitReply(c.id);
                      }}
                    >
                      Post reply
                    </button>
                  </div>
                </div>
              ) : null}

              {c.replies.length > 0 ? (
                <ul
                  style={{
                    listStyle: 'none',
                    padding: 0,
                    margin: 0,
                    marginLeft: 'var(--space-4)',
                  }}
                  className="stack-sm"
                >
                  {c.replies.map((r) => (
                    <li
                      key={r.id}
                      className="card--tight stack-sm"
                      style={{ padding: 'var(--space-3)' }}
                    >
                      <AuthorLine
                        authorUsername={r.author_username}
                        authorName={r.author_name}
                        createdAt={r.created_at}
                        edited={r.edited}
                      />
                      {editId === r.id ? (
                        <div className="stack-sm">
                          <textarea
                            className="input"
                            rows={3}
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                          />
                          <div className="row" style={{ gap: 'var(--space-2)' }}>
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={busy || editDraft.trim().length === 0}
                              onClick={() => {
                                void saveEdit(r.id);
                              }}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => {
                                setEditId(null);
                                setEditDraft('');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p>
                      )}
                      {myId === r.user_id && editId !== r.id ? (
                        <div className="row" style={{ gap: 'var(--space-2)' }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              setEditId(r.id);
                              setEditDraft(r.body);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              void deleteComment(r.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      ) : myId !== r.user_id ? (
                        <div className="row" style={{ gap: 'var(--space-2)' }}>
                          <ReportButton targetType="comment" targetId={r.id} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
