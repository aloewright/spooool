import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { users } from "../db/schema";
import type { Env } from "../env";
import { encryptSecret } from "../lib/keyring";
import { type AuthVariables, requireUser } from "../middleware/auth";

export const accountRoute = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

accountRoute.use("*", requireUser);

accountRoute.get("/me", (c) => {
  const user = c.get("user");
  return c.json({ user });
});

accountRoute.get("/elevenlabs-key", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ configured: users.elevenlabs_key_ciphertext })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  return c.json({ configured: Boolean(row?.configured) });
});

accountRoute.get("/emdash-token", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ configured: users.emdash_token_ciphertext })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  return c.json({ configured: Boolean(row?.configured) });
});

accountRoute.put("/emdash-token", async (c) => {
  const user = c.get("user");
  const body = z.object({ token: z.string().min(8).max(500) }).parse(await c.req.json());
  const encrypted = await encryptSecret(body.token, c.env.KEYRING_MASTER_KEY);
  await drizzle(c.env.DB)
    .update(users)
    .set({
      emdash_token_ciphertext: encrypted.ciphertext,
      emdash_token_iv: encrypted.iv,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  return c.json({ configured: true });
});

accountRoute.put("/elevenlabs-key", async (c) => {
  const user = c.get("user");
  const body = z.object({ api_key: z.string().min(12).max(500) }).parse(await c.req.json());
  const encrypted = await encryptSecret(body.api_key, c.env.KEYRING_MASTER_KEY);
  await drizzle(c.env.DB)
    .update(users)
    .set({
      elevenlabs_key_ciphertext: encrypted.ciphertext,
      elevenlabs_key_iv: encrypted.iv,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  return c.json({ configured: true });
});
