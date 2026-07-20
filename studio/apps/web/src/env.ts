// CloudflareBindings is declared globally by `wrangler types` in
// worker-configuration.d.ts. It includes vars + bindings, but NOT secrets
// (secrets are injected at runtime by Wrangler). We extend it here so the
// rest of the codebase has a single Env type.

import type { Container } from "@cloudflare/containers";
import type { AudiobookMasteringWorkflowParams } from "./workflows/audiobook-mastering";
import type { BookExportWorkflowParams } from "./workflows/book-export";
import type { GtmBriefWorkflowParams } from "./workflows/gtm-brief";

type Secrets = {
  BETTER_AUTH_SECRET: string;
  AI_GATEWAY_BASE_URL: string;
  AI_GATEWAY_TOKEN: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  RENDER_WORKER_INTERNAL_TOKEN: string;
  KEYRING_MASTER_KEY: string;
};

export type Env = Omit<CloudflareBindings, "ENV"> &
  Secrets & {
    // Widen literal "dev" to the real set of environments.
    ENV: "dev" | "staging" | "prod";
    // Container-backed Durable Object binding — refreshed on next `wrangler types` run.
    RENDER_WORKER?: DurableObjectNamespace<Container<Env>>;
    BOOK_EXPORT_WORKFLOW?: Workflow<BookExportWorkflowParams>;
    AUDIOBOOK_MASTERING_WORKFLOW?: Workflow<AudiobookMasteringWorkflowParams>;
    GTM_BRIEF_WORKFLOW?: Workflow<GtmBriefWorkflowParams>;
    // R2 S3-compatible settings forwarded to render containers when available.
    S3_ENDPOINT?: string;
    R2_BUCKET?: string;
    // Google OAuth — injected as Wrangler secrets.
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    // Sentry DSN for error reporting.
    SENTRY_DSN?: string;
    // pub.fly.pm publishing platform for em_dash blogs; defaults to
    // https://pub.fly.pm when unset.
    EMDASH_PUB_BASE_URL?: string;
  };
