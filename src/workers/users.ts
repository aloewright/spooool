import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { purgeEdgeCache } from './edge-cache';

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_BANNER_BYTES = 5 * 1024 * 1024;

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,29})$/;

type SessionUser = { id: string; email: string; name: string };

export interface UserEnv {
  DB: D1Database;
  VIDEOS: R2Bucket;
}

export interface UserVariables {
  user: SessionUser | null;
}

const profileUpdateSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(30)
    .regex(USERNAME_RE, 'Username must be 2-30 chars, lowercase letters/numbers/_/-')
    .optional(),
  displayName: z.string().min(1).max(80).optional(),
  bio: z.string().max(500).optional(),
});

interface UserProfileRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
}

export const userRoutes = new Hono<{
  Bindings: UserEnv;
  Variables: UserVariables;
}>();

userRoutes.get('/api/users/me', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    `SELECT id, email, name, username, displayName, bio, avatarUrl, bannerUrl
     FROM user WHERE id = ?`,
  )
    .bind(user.id)
    .first<UserProfileRow>();
  if (!row) return c.json({ error: 'User not found' }, 404);
  return c.json(row);
});

userRoutes.put('/api/users/me', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid profile fields', details: parsed.error.flatten() }, 400);
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.username !== undefined) {
    const taken = await c.env.DB.prepare('SELECT id FROM user WHERE username = ? AND id != ?')
      .bind(parsed.data.username, user.id)
      .first();
    if (taken) return c.json({ error: 'Username taken' }, 409);
    updates.push('username = ?');
    values.push(parsed.data.username);
  }
  if (parsed.data.displayName !== undefined) {
    updates.push('displayName = ?');
    values.push(parsed.data.displayName);
  }
  if (parsed.data.bio !== undefined) {
    updates.push('bio = ?');
    values.push(parsed.data.bio);
  }
  if (updates.length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  updates.push('updatedAt = ?');
  values.push(Date.now());
  values.push(user.id);

  await c.env.DB.prepare(`UPDATE user SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const refreshed = await c.env.DB.prepare(
    `SELECT id, email, name, username, displayName, bio, avatarUrl, bannerUrl FROM user WHERE id = ?`,
  )
    .bind(user.id)
    .first<UserProfileRow>();

  if (refreshed?.username) {
    await purgeEdgeCache([`/api/channels/${refreshed.username}`], new URL(c.req.url).origin);
  }
  return c.json(refreshed);
});

async function uploadProfileImage(
  c: Context<{ Bindings: UserEnv; Variables: UserVariables }>,
  user: SessionUser,
  prefix: 'avatars' | 'banners',
  maxBytes: number,
  column: 'avatarUrl' | 'bannerUrl',
): Promise<Response> {
  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing image file' }, 400);
  }
  if (!ALLOWED_IMAGE_MIME.has(file.type)) {
    return c.json({ error: `Unsupported image type: ${file.type || 'unknown'}` }, 400);
  }
  if (file.size > maxBytes) {
    return c.json({ error: `Image exceeds ${maxBytes} bytes` }, 400);
  }

  const ext = ALLOWED_IMAGE_EXT[file.type];
  const objectName = `${crypto.randomUUID()}.${ext}`;
  const r2Key = `${prefix}/${user.id}/${objectName}`;
  await c.env.VIDEOS.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  const url = new URL(c.req.url);
  url.pathname = `/api/users/${prefix}/${user.id}/${objectName}`;
  url.search = '';
  const publicUrl = url.toString();

  await c.env.DB.prepare(
    `UPDATE user SET ${column} = ?, updatedAt = ? WHERE id = ?`,
  )
    .bind(publicUrl, Date.now(), user.id)
    .run();

  // Purge the channel profile page — avatar/banner change is visible there.
  const usernameRow = await c.env.DB.prepare('SELECT username FROM user WHERE id = ?')
    .bind(user.id)
    .first<{ username: string | null }>();
  if (usernameRow?.username) {
    await purgeEdgeCache([`/api/channels/${usernameRow.username}`], new URL(c.req.url).origin);
  }

  return c.json({ url: publicUrl }, 201);
}

userRoutes.post('/api/users/me/avatar', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  return uploadProfileImage(c, user, 'avatars', MAX_AVATAR_BYTES, 'avatarUrl');
});

userRoutes.post('/api/users/me/banner', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  return uploadProfileImage(c, user, 'banners', MAX_BANNER_BYTES, 'bannerUrl');
});

async function serveProfileImage(
  c: Context<{ Bindings: UserEnv; Variables: UserVariables }>,
  prefix: 'avatars' | 'banners',
): Promise<Response> {
  const userId = c.req.param('userId');
  const objectName = c.req.param('objectName');
  if (!objectName || !/^[a-zA-Z0-9._-]+$/.test(objectName)) {
    return c.json({ error: 'Invalid object name' }, 400);
  }
  const r2Key = `${prefix}/${userId}/${objectName}`;
  const object = await c.env.VIDEOS.get(r2Key);
  if (!object) return c.json({ error: 'Not found' }, 404);
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

userRoutes.get('/api/users/avatars/:userId/:objectName', (c) =>
  serveProfileImage(c, 'avatars'),
);
userRoutes.get('/api/users/banners/:userId/:objectName', (c) =>
  serveProfileImage(c, 'banners'),
);
