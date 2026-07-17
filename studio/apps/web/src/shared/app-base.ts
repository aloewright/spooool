// The app serves from "/" on book-cook.com and from "/studio" on spooool.com
// (zone route spooool.com/studio* — see wrangler.jsonc). These helpers keep a
// single build working at both bases: the worker strips the prefix before
// routing (src/index.ts), built HTML gets its root-absolute asset URLs
// rebased on the way out, and everything inside the JS bundle resolves
// through globalThis.__appBase (set inline in index.html, consumed by
// vite.config.ts renderBuiltUrl and client/lib/app-base.ts).
export const APP_BASE_PREFIX = "/studio";

export function detectAppBase(pathname: string): "" | typeof APP_BASE_PREFIX {
  return pathname === APP_BASE_PREFIX || pathname.startsWith(`${APP_BASE_PREFIX}/`)
    ? APP_BASE_PREFIX
    : "";
}

// Folds the base into root-absolute src/href attributes in built HTML
// (entry script, modulepreloads, css, favicon). Protocol-relative URLs
// ("//cdn…") are left alone.
export function rewriteHtmlBase(html: string, base: string): string {
  if (!base) return html;
  const rebasedHtml = html.replace(/(src|href)="\/(?!\/)/g, `$1="${base}/`);
  return base === APP_BASE_PREFIX
    ? rebasedHtml.replace(/<title>[^<]*<\/title>/i, "<title>Editor</title>")
    : rebasedHtml;
}
