// Shared helpers for *.workers.test.ts integration suites.

import type { D1Database } from '@cloudflare/workers-types';

/** videos.user_id FK targets legacy `users`; list/detail JOINs use better-auth `user`. */
export async function seedTestCreator(
  db: D1Database,
  id: string,
  email: string,
  displayName: string,
): Promise<void> {
  const username = id.replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'user';
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO users (id, email, username, display_name)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, email, username, displayName)
    .run();
  await db
    .prepare(
      `INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, email, displayName, now, now)
    .run();
}

export async function signStreamWebhookBody(
  body: string,
  secret: string,
  time = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${time}.${body}`),
  );
  const sig1 = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `time=${time},sig1=${sig1}`;
}
