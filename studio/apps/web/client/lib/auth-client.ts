import { createAuthClient } from "better-auth/react";
import { appBase } from "./app-base";

export const authClient = createAuthClient({
  // baseURL must stay origin-only: better-auth returns a path-bearing baseURL
  // as-is and would skip the /api/auth segment. The /studio prefix (when
  // served via spooool.com/studio) goes in basePath instead.
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  basePath: `${appBase}/api/auth`,
});
