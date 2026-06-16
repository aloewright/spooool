// Thin client for em_dash (Cloudflare's open-source blog framework) via the
// pub.fly.pm publishing platform. Users authenticate once with a pub.fly.pm
// token (stored encrypted, like the ElevenLabs key); each blog is bound to an
// em_dash site (a Cloudflare domain) and posts publish straight through.

import type { Env } from "../env";

const DEFAULT_BASE_URL = "https://pub.fly.pm";

function baseUrl(env: Pick<Env, "EMDASH_PUB_BASE_URL">): string {
  return (env.EMDASH_PUB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

export type EmdashPublishInput = {
  title: string;
  body_md: string;
  summary?: string;
};

export type EmdashPublishResult = {
  id: string;
  url?: string;
};

export async function publishEmdashPost(
  env: Pick<Env, "EMDASH_PUB_BASE_URL">,
  token: string,
  site: string,
  input: EmdashPublishInput,
  f: typeof fetch = fetch,
): Promise<EmdashPublishResult> {
  const res = await f(`${baseUrl(env)}/api/v1/sites/${encodeURIComponent(site)}/posts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: input.title,
      content_md: input.body_md,
      excerpt: input.summary ?? "",
      status: "published",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`em_dash publish failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { id?: string; url?: string };
  return { id: json.id ?? "", url: json.url };
}
