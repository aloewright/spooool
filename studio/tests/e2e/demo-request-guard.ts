export const LOCAL_DEMO_BASE_URL = "http://localhost:4190";
export const LOCAL_DEMO_ORIGIN = new URL(LOCAL_DEMO_BASE_URL).origin;

export const isLocalStudioApiUrl = (rawUrl: string): boolean => {
  const url = new URL(rawUrl);
  return url.origin === LOCAL_DEMO_ORIGIN && url.pathname.startsWith("/api/v1/");
};
