/// <reference types="vite/client" />

// Recorder: injected by the upstream server (remotion-dev/recorder) to signal server availability.
// In spooool, this will always be undefined (server-side features are not enabled).
declare global {
  interface Window {
    remotionServerEnabled: boolean | undefined;
  }
}
