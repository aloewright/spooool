/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TURNSTILE_SITE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Recorder: injected by the upstream server (remotion-dev/recorder) to signal server availability.
// In spooool, this will always be undefined (server-side features are not enabled).
declare global {
  interface Window {
    remotionServerEnabled: boolean | undefined;
  }
}
