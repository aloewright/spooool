// Merged single-worker Env for the relocated studio backend (src/hub).
//
// Replaces the old wrangler-generated `CloudflareBindings` global: this module
// is now compiled under spooool's root tsconfig, so every binding / var /
// secret the hub uses is enumerated explicitly here. The merged worker's
// EnvBindings (src/workers/index.ts) includes this type via intersection, so
// the same runtime env object satisfies both spooool's and the hub's routes.
//
// See docs/superpowers/specs/2026-06-15-studio-single-worker-merge-design.md.

import type { Container } from "@cloudflare/containers";
import type { AudiobookMasteringWorkflowParams } from "./workflows/audiobook-mastering";
import type { BookExportWorkflowParams } from "./workflows/book-export";
import type { GtmBriefWorkflowParams } from "./workflows/gtm-brief";

export type Env = {
  // D1 — spooool-prod is the merged worker's primary DB (DB, used here only to
  // read spooool's session for federation); the studio's own content lives in
  // STUDIO_DB (the rebound `bookgenerators` D1).
  DB: D1Database;
  STUDIO_DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  AI?: Ai;

  // Container-backed Durable Object for EPUB/PDF/audio renders.
  RENDER_WORKER?: DurableObjectNamespace<Container<Env>>;

  // Workflows.
  BOOK_EXPORT_WORKFLOW?: Workflow<BookExportWorkflowParams>;
  AUDIOBOOK_MASTERING_WORKFLOW?: Workflow<AudiobookMasteringWorkflowParams>;
  GTM_BRIEF_WORKFLOW?: Workflow<GtmBriefWorkflowParams>;

  // Environment + URLs (wrangler [vars]).
  ENV: "dev" | "staging" | "prod";
  POSTPILOT_BASE_URL: string;
  EMDASH_PUB_BASE_URL?: string;
  R2_BUCKET?: string;
  S3_ENDPOINT?: string;

  // Secrets (provisioned as worker secrets at deploy time; not needed for
  // local type-check / build).
  BETTER_AUTH_SECRET: string;
  AI_GATEWAY_BASE_URL: string;
  AI_GATEWAY_TOKEN: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  RENDER_WORKER_INTERNAL_TOKEN: string;
  KEYRING_MASTER_KEY: string;
};
