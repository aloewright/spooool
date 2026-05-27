// Extend Window with recorder-specific globals
declare global {
  interface Window {
    remotionServerEnabled: boolean | undefined;
  }
}

export {};
