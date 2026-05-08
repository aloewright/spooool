// ALO-183: canonical list of help-article slugs. Imported by both the React
// frontend (src/frontend/pages/Help.tsx) and the SEO worker
// (src/workers/seo.ts) so the sitemap and the rendered article catalog can't
// drift. Plain TS module with no React imports — safe to bundle into a Worker.

export const HELP_ARTICLE_SLUGS = [
  'quickstart',
  'upload-guide',
  'encoding-tips',
  'monetization-faq',
] as const;

export type HelpArticleSlug = (typeof HELP_ARTICLE_SLUGS)[number];
