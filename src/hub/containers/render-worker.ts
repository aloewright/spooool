import { Container } from "@cloudflare/containers";
import type { Env } from "../env";

export class RenderWorkerContainer extends Container<Env> {
  defaultPort = 8787;
  sleepAfter = "2m";
  enableInternet = true;

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    this.envVars = {
      PORT: "8787",
      RENDER_WORKER_INTERNAL_TOKEN: env.RENDER_WORKER_INTERNAL_TOKEN ?? "",
      S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID ?? "",
      S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY ?? "",
      S3_ENDPOINT: env.S3_ENDPOINT ?? "",
      R2_BUCKET: env.R2_BUCKET ?? "bookgenerators",
    };
  }

  override onStart() {
    console.log("render-worker container started");
  }

  override onStop() {
    console.log("render-worker container stopped");
  }

  override onError(error: unknown) {
    console.error("render-worker container error", error);
  }
}
