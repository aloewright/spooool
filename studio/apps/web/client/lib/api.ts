import { QueryClient } from "@tanstack/react-query";
import { withBase } from "./app-base";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

let redirectingToSignIn = false;

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withBase(path), {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (res.status === 401) {
    if (
      typeof window !== "undefined" &&
      !redirectingToSignIn &&
      !window.location.pathname.startsWith(withBase("/sign-"))
    ) {
      redirectingToSignIn = true;
      window.location.assign(withBase("/sign-in"));
    }
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `${res.status}: ${(body as { error?: { message?: string } }).error?.message ?? res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

// DELETE endpoints return 204 with no body; surface HTTP errors instead of
// letting mutations "succeed" on a failed response.
async function deleteResource(path: string): Promise<void> {
  const res = await fetch(withBase(path), { method: "DELETE", credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `${res.status}: ${(body as { error?: { message?: string } }).error?.message ?? res.statusText}`,
    );
  }
}

export type Project = {
  id: string;
  title: string;
  type: "nonfiction" | "fiction";
  genre?: string | null;
  logline?: string;
  audience_json?: string[];
  voice_styles_json?: string[];
  status: string;
  voice_id?: string | null;
  created_at: number;
  updated_at: number;
  deleted_at?: number | string | null;
};

export type BlogFormatId =
  | "serialized-fiction"
  | "how-to"
  | "opinion"
  | "case-study"
  | "listicle"
  | "interview"
  | "newsletter"
  | "transcript"
  | "interactive"
  | "meta";

export type Blog = {
  id: string;
  title: string;
  format: BlogFormatId;
  description: string;
  structure?: string | null;
  planned_posts: number;
  status: "concept" | "planning" | "drafting" | "publishing" | "live";
  emdash_site?: string | null;
  created_at: number;
  updated_at: number;
  deleted_at?: number | string | null;
};

export type BlogDetail = Blog & {
  audience_json: string[];
  voice_links_json: string[];
  voice_uploads_json: { name: string; text: string }[];
  voice_profile_md: string;
  rules_do_json: string[];
  rules_dont_json: string[];
};

export type BlogPost = {
  id: string;
  blog_id: string;
  ordinal: number;
  title: string;
  summary: string;
  draft_json?: unknown;
  draft_md: string;
  status: "planned" | "drafting" | "drafted" | "published";
  emdash_post_id?: string | null;
  published_at?: number | null;
  created_at: number;
  updated_at: number;
};

export type ScriptFormatId = "feature" | "tv-episode" | "short-film" | "stage-play";

export type Script = {
  id: string;
  title: string;
  format: ScriptFormatId;
  logline: string;
  genre?: string | null;
  structure?: string | null;
  planned_scenes: number;
  status: "concept" | "planning" | "drafting" | "complete";
  created_at: number;
  updated_at: number;
  deleted_at?: number | string | null;
};

export type ScriptScene = {
  id: string;
  script_id: string;
  ordinal: number;
  title: string;
  summary: string;
  draft_json?: unknown;
  draft_md: string;
  status: "planned" | "drafting" | "drafted";
  created_at: number;
  updated_at: number;
};

export type CreateScriptInput = {
  title: string;
  format: ScriptFormatId;
  logline: string;
  genre?: string;
};

export type BlogVoiceUpload = { name: string; text: string };

export type CreateBlogInput = {
  title: string;
  format: BlogFormatId;
  description: string;
  audience: string[];
  voice_links: string[];
  voice_uploads: BlogVoiceUpload[];
  voice_profile_md?: string;
  rules_do: string[];
  rules_dont: string[];
};

export type VoiceSample = {
  id: string;
  voice_id: string;
  r2_key: string;
  source: "paste" | "upload" | "url";
  word_count: number;
  created_at: number;
};

export type Voice = {
  id: string;
  name: string;
  source: "custom" | "postpilot";
  postpilot_slug?: string | null;
  profile_md: string;
  profile_json: unknown;
  created_at: number;
  updated_at: number;
  samples?: VoiceSample[];
};

export type PostPilotGuide = {
  slug: string;
  author: string;
  era?: string;
  kicker?: string;
  standfirst?: string;
  copyright_posture?: string;
};

export type Chapter = {
  id: string;
  project_id: string;
  ordinal: number;
  title: string;
  summary: string;
  status: string;
  target_words: number;
  draft_json?: unknown;
  draft_md: string;
  created_at: number;
  updated_at: number;
};

export type Section = {
  id: string;
  chapter_id: string;
  ordinal: number;
  kind: string;
  prompt: string;
  draft_md: string;
  beginning_md: string;
  middle_md: string;
  end_md: string;
  status: "pending" | "generating" | "drafted" | "approved";
  created_at: number;
  updated_at: number;
};

export type Revision = {
  id: string;
  target_table: string;
  target_id: string;
  before_md: string;
  after_md: string;
  llm_response?: unknown;
  created_at?: number;
};

export type InlineEditAction = "rewrite" | "tighten" | "expand" | "change-tone" | "fix-grammar";
export type InlineEditTone = "formal" | "casual" | "punchy";

export type ProjectOutline = {
  id: string;
  project_id: string;
  framework: string;
  structure_json: unknown;
  version: number;
  created_at: number;
  updated_at: number;
};

export type CharacterArcInput = {
  name: string;
  arc: string;
  position: string;
  sceneRole?: string;
};

export type ScenePlanInput = {
  defaultCast?: string;
  miniStructure?: string;
};

export type ChapterPlanInput = {
  ordinal: number;
  title?: string;
  event: string;
  purpose?: string;
  pov?: string;
  characters?: string;
};

export type PublisherPack = {
  id: string;
  title: string;
  subtitle: string;
  series_name: string;
  description_html: string;
  keywords: string[];
  bisac: string[];
  status: "draft" | "approved";
};

export type RenderJob = {
  id: string;
  project_id: string;
  kind: "epub" | "docx" | "pdf" | "kpf" | "narration" | "master_mix";
  status: "queued" | "running" | "completed" | "failed";
  workflow_id?: string | null;
  output_r2_key?: string | null;
  error?: string | null;
  started_at: number;
  completed_at?: number | null;
  cost_cents: number;
  download_url?: string | null;
};

export type ExportKind = "epub" | "pdf" | "kpf";

export type FullBookChapter = {
  id?: string;
  ordinal: number;
  title: string;
  summary: string;
  body_md: string;
  word_count: number;
  has_draft: boolean;
};

export type FullBookView = {
  title: string;
  chapters: FullBookChapter[];
  manuscript_md: string;
  total_words: number;
  drafted_chapters: number;
};

export type NarrationAudition = RenderJob & {
  voice_id: string;
  audio_url?: string | null;
};

export type NarrationApproval = {
  job_id: string;
  voice_id: string;
  output_r2_key: string;
  approved_at: string;
};

export type MarketRecord = {
  source: "kdp" | "trends" | "library";
  niche: string;
  title: string;
  author: string;
  rank: number;
  signal: string;
  keywords: string[];
  observed_at: string;
};

export type ScoutEvidence = {
  dataset: {
    snapshot_id: string;
    week_iso: string;
    r2_key: string;
    source: string;
  };
  niche: string;
  type: "nonfiction" | "fiction";
  input_context?: {
    audience?: string;
    angle?: string;
  };
  records: MarketRecord[];
  source_mix?: {
    kdp: number;
    trends: number;
    library: number;
  };
  keyword_counts?: { keyword: string; count: number }[];
  opportunity_score?: number;
  confidence?: "low" | "medium" | "high";
  audience_brief?: string;
  positioning_brief?: string;
  verdict?: {
    status: "ready" | "validate" | "reframe";
    label: string;
    rationale: string;
  };
  concept_brief?: {
    audience: string;
    promise: string;
    differentiator: string;
    must_prove: string;
  };
  gaps: string[];
  recommendations: string[];
  validation_steps?: string[];
  next_questions?: string[];
};

export type ScoutQuery = {
  id: string;
  user_id: string;
  project_id?: string | null;
  niche: string;
  type: "nonfiction" | "fiction";
  params_json: Record<string, unknown>;
  created_at: string | number;
};

export type ScoutFinding = {
  id: string;
  query_id: string;
  dataset_snapshot_id: string;
  summary_md: string;
  evidence_json: ScoutEvidence;
  created_at: string | number;
};

export type ScoutResult = {
  query: ScoutQuery;
  finding: ScoutFinding;
  snapshot?: {
    id: string;
    week_iso: string;
    r2_key: string;
    source: string;
    created_at: string | number;
  };
};

export type GtmBriefContent = {
  title: string;
  subtitle: string;
  positioning: string;
  comp_titles: string[];
  launch_checklist: string[];
  preorder_copy: { headline: string; body: string };
  email_sequence: { subject: string; body: string }[];
  ad_headlines: string[];
  arc_reader_brief: string;
  milestones: {
    week_1: string[];
    month_1: string[];
    month_3: string[];
  };
};

export type GtmBrief = {
  id: string;
  project_id: string;
  content_json: GtmBriefContent;
  brief_md: string;
  r2_key: string;
  created_at: string | number;
  updated_at: string | number;
  download_url?: string | null;
};

export const api = {
  listProjects: () => fetchJson<{ items: Project[] }>("/api/v1/projects"),
  listDeletedProjects: () =>
    fetchJson<{ items: Project[]; retention_days: number }>("/api/v1/projects/deleted/recent"),
  createProject: (input: {
    title: string;
    type: "nonfiction" | "fiction";
    genre?: string;
    logline?: string;
    audience?: string[];
    voice_styles?: string[];
  }) =>
    fetchJson<{ id: string }>("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  generateLogline: (input: {
    title?: string;
    protagonist?: string;
    conflict?: string;
    stakes?: string;
    type?: "fiction" | "nonfiction";
  }) =>
    fetchJson<{ logline: string }>("/api/v1/compose/logline", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getProject: (id: string) => fetchJson<Project>(`/api/v1/projects/${id}`),
  getProjectOutline: (id: string) =>
    fetchJson<{ outline: ProjectOutline | null; chapters: Chapter[] }>(
      `/api/v1/projects/${id}/outline`,
    ),
  generateProjectOutline: (
    id: string,
    input: {
      framework?: string;
      questionnaire: string;
      character_arcs?: CharacterArcInput[];
      scene_plan?: ScenePlanInput;
      chapter_plan?: ChapterPlanInput[];
    },
  ) =>
    fetchJson<{ id: string; outline: unknown; chapters_created: number }>(
      `/api/v1/projects/${id}/outlines`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  getPublisherPack: (id: string) =>
    fetchJson<{ pack: PublisherPack | null }>(`/api/v1/projects/${id}/publisher-pack`),
  generatePublisherSeo: (id: string) =>
    fetchJson<{ pack: PublisherPack; llm_response: unknown }>(
      `/api/v1/projects/${id}/publisher-pack/seo`,
      { method: "POST" },
    ),
  updatePublisherPack: (id: string, input: Omit<PublisherPack, "id" | "status">) =>
    fetchJson<{ pack: PublisherPack }>(`/api/v1/projects/${id}/publisher-pack`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  approvePublisherPack: (id: string) =>
    fetchJson<{ pack: PublisherPack }>(`/api/v1/projects/${id}/publisher-pack/approve`, {
      method: "POST",
    }),
  getFullBook: (id: string) =>
    fetchJson<{
      project: Pick<Project, "id" | "title">;
      book: FullBookView;
      export_formats: ExportKind[];
    }>(`/api/v1/projects/${id}/book`),
  listRenderJobs: (id: string) =>
    fetchJson<{ items: RenderJob[] }>(`/api/v1/projects/${id}/export/jobs`),
  startBookExport: (id: string, input?: { formats?: ExportKind[] }) =>
    fetchJson<{ id: string }>(`/api/v1/projects/${id}/export`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  listBlogs: () => fetchJson<{ items: Blog[] }>("/api/v1/blogs"),
  listDeletedBlogs: () =>
    fetchJson<{ items: Blog[]; retention_days: number }>("/api/v1/blogs/deleted/recent"),
  createBlog: (input: CreateBlogInput) =>
    fetchJson<{ id: string }>("/api/v1/blogs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getBlog: (id: string) => fetchJson<BlogDetail>(`/api/v1/blogs/${id}`),
  updateBlog: (
    id: string,
    input: { title?: string; description?: string; emdash_site?: string | null },
  ) =>
    fetchJson<{ ok: true }>(`/api/v1/blogs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  planBlog: (id: string, input: { structure: string; planned_posts: number }) =>
    fetchJson<{ ok: true; posts_created: number }>(`/api/v1/blogs/${id}/plan`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listBlogPosts: (id: string) => fetchJson<{ items: BlogPost[] }>(`/api/v1/blogs/${id}/posts`),
  getBlogPost: (id: string, postId: string) =>
    fetchJson<BlogPost>(`/api/v1/blogs/${id}/posts/${postId}`),
  updateBlogPost: (
    id: string,
    postId: string,
    input: {
      title?: string;
      summary?: string;
      draft_json?: unknown;
      draft_md?: string;
      status?: BlogPost["status"];
    },
    options?: { signal?: AbortSignal },
  ) =>
    fetchJson<{ ok: true }>(`/api/v1/blogs/${id}/posts/${postId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
      signal: options?.signal,
    }),
  publishBlogPost: (id: string, postId: string) =>
    fetchJson<{ ok: true; emdash_post_id: string; url: string | null }>(
      `/api/v1/blogs/${id}/posts/${postId}/publish`,
      { method: "POST" },
    ),
  deleteBlog: (id: string) => deleteResource(`/api/v1/blogs/${id}`),
  restoreBlog: (id: string) =>
    fetchJson<{ ok: true }>(`/api/v1/blogs/${id}/restore`, { method: "POST" }),
  listScripts: () => fetchJson<{ items: Script[] }>("/api/v1/scripts"),
  listDeletedScripts: () =>
    fetchJson<{ items: Script[]; retention_days: number }>("/api/v1/scripts/deleted/recent"),
  createScript: (input: CreateScriptInput) =>
    fetchJson<{ id: string }>("/api/v1/scripts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getScript: (id: string) => fetchJson<Script>(`/api/v1/scripts/${id}`),
  updateScript: (id: string, input: { title?: string; logline?: string }) =>
    fetchJson<{ ok: true }>(`/api/v1/scripts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  planScript: (id: string, input: { structure: string; planned_scenes: number }) =>
    fetchJson<{ ok: true; scenes_created: number }>(`/api/v1/scripts/${id}/plan`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listScriptScenes: (id: string) =>
    fetchJson<{ items: ScriptScene[] }>(`/api/v1/scripts/${id}/scenes`),
  getScriptScene: (id: string, sceneId: string) =>
    fetchJson<ScriptScene>(`/api/v1/scripts/${id}/scenes/${sceneId}`),
  updateScriptScene: (
    id: string,
    sceneId: string,
    input: {
      title?: string;
      summary?: string;
      draft_json?: unknown;
      draft_md?: string;
      status?: ScriptScene["status"];
    },
    options?: { signal?: AbortSignal },
  ) =>
    fetchJson<{ ok: true }>(`/api/v1/scripts/${id}/scenes/${sceneId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
      signal: options?.signal,
    }),
  deleteScript: (id: string) => deleteResource(`/api/v1/scripts/${id}`),
  restoreScript: (id: string) =>
    fetchJson<{ ok: true }>(`/api/v1/scripts/${id}/restore`, { method: "POST" }),
  extrapolateBlogVoice: (input: { links: string[]; uploads: BlogVoiceUpload[] }) =>
    fetchJson<{ profile_md: string; samples_used: number }>("/api/v1/compose/blog-voice", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getEmdashTokenStatus: () => fetchJson<{ configured: boolean }>("/api/v1/account/emdash-token"),
  saveEmdashToken: (token: string) =>
    fetchJson<{ configured: boolean }>("/api/v1/account/emdash-token", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),
  getElevenLabsKeyStatus: () =>
    fetchJson<{ configured: boolean }>("/api/v1/account/elevenlabs-key"),
  saveElevenLabsKey: (apiKey: string) =>
    fetchJson<{ configured: boolean }>("/api/v1/account/elevenlabs-key", {
      method: "PUT",
      body: JSON.stringify({ api_key: apiKey }),
    }),
  listNarrationAuditions: (id: string) =>
    fetchJson<{ items: NarrationAudition[]; approved: NarrationApproval | null }>(
      `/api/v1/projects/${id}/narration/auditions`,
    ),
  startNarrationAudition: (id: string, voiceIds: string[]) =>
    fetchJson<{ items: NarrationAudition[]; script: { chunks: number } }>(
      `/api/v1/projects/${id}/narration/audition`,
      {
        method: "POST",
        body: JSON.stringify({ elevenlabs_voice_ids: voiceIds }),
      },
    ),
  approveNarrationAudition: (id: string, jobId: string) =>
    fetchJson<{ approved: NarrationApproval }>(
      `/api/v1/projects/${id}/narration/auditions/${jobId}/approve`,
      { method: "POST" },
    ),
  listAudiobookJobs: (id: string) =>
    fetchJson<{ items: RenderJob[] }>(`/api/v1/projects/${id}/audiobook/jobs`),
  startAudiobookMastering: (id: string) =>
    fetchJson<{ id: string }>(`/api/v1/projects/${id}/audiobook`, { method: "POST" }),
  listScoutQueries: () => fetchJson<{ items: ScoutResult[] }>("/api/v1/scout/queries"),
  createScoutQuery: (input: {
    niche: string;
    type: "nonfiction" | "fiction";
    project_id?: string;
    params?: Record<string, unknown>;
  }) =>
    fetchJson<ScoutResult>("/api/v1/scout/queries", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listProjectScoutFindings: (id: string) =>
    fetchJson<{ items: ScoutResult[] }>(`/api/v1/scout/projects/${id}/findings`),
  getGtmBrief: (id: string) =>
    fetchJson<{ brief: GtmBrief | null }>(`/api/v1/projects/${id}/launch/brief`),
  startGtmBrief: (id: string) =>
    fetchJson<{ id: string }>(`/api/v1/projects/${id}/launch/brief`, { method: "POST" }),
  getChapter: (id: string) => fetchJson<Chapter>(`/api/v1/chapters/${id}`),
  getChapterSections: (id: string) =>
    fetchJson<{ items: Section[] }>(`/api/v1/chapters/${id}/sections`),
  draftSection: (chapterId: string, sectionId: string, input?: { instruction?: string }) =>
    fetchJson<{ section: Section; revision: Revision }>(
      `/api/v1/chapters/${chapterId}/sections/${sectionId}/draft`,
      {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      },
    ),
  createSection: (chapterId: string, input?: { kind?: string; prompt?: string }) =>
    fetchJson<{ section: Section }>(`/api/v1/chapters/${chapterId}/sections`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  reorderSections: (chapterId: string, ordinals: { id: string; ordinal: number }[]) =>
    fetchJson<{ ok: true }>(`/api/v1/chapters/${chapterId}/sections/reorder`, {
      method: "POST",
      body: JSON.stringify({ ordinals }),
    }),
  moveSectionToChapter: (fromChapterId: string, sectionId: string, targetChapterId: string) =>
    fetchJson<{ section: Section }>(
      `/api/v1/chapters/${fromChapterId}/sections/${sectionId}/move`,
      { method: "POST", body: JSON.stringify({ target_chapter_id: targetChapterId }) },
    ),
  updateSection: (
    chapterId: string,
    sectionId: string,
    input: {
      status?: Section["status"];
      draft_md?: string;
      prompt?: string;
      beginning_md?: string;
      middle_md?: string;
      end_md?: string;
    },
    options?: { signal?: AbortSignal },
  ) =>
    fetchJson<{ ok: true }>(`/api/v1/chapters/${chapterId}/sections/${sectionId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
      signal: options?.signal,
    }),
  getChapterRevisions: (id: string) =>
    fetchJson<{ items: Revision[] }>(`/api/v1/chapters/${id}/revisions`),
  reviseChapterSelection: (
    id: string,
    input: {
      action: InlineEditAction;
      tone?: InlineEditTone;
      text: string;
      context_md?: string;
    },
  ) =>
    fetchJson<{ revision: Revision }>(`/api/v1/chapters/${id}/revise`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateChapter: (
    id: string,
    input: {
      title?: string;
      summary?: string;
      draft_json?: unknown;
      draft_md?: string;
      status?: Chapter["status"];
    },
  ) =>
    fetchJson<{ ok: true }>(`/api/v1/chapters/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  updateProject: (id: string, input: { voice_id?: string | null }) =>
    fetchJson<{ ok: true }>(`/api/v1/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  getProjectChat: (id: string) =>
    fetchJson<{ items: { role: "user" | "assistant"; text: string }[] }>(
      `/api/v1/projects/${id}/chat`,
    ),
  deleteProject: (id: string) => deleteResource(`/api/v1/projects/${id}`),
  restoreProject: (id: string) =>
    fetchJson<{ ok: true }>(`/api/v1/projects/${id}/restore`, { method: "POST" }),
  listVoices: () => fetchJson<{ items: Voice[] }>("/api/v1/voices"),
  listPostPilotGuides: () =>
    fetchJson<{ items: PostPilotGuide[] }>("/api/v1/voices/postpilot-guides"),
  getVoice: (id: string) => fetchJson<Voice>(`/api/v1/voices/${id}`),
  createVoice: (input: { name: string; samples?: { source: "paste"; text: string }[] }) =>
    fetchJson<{ id: string }>("/api/v1/voices", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  importPostPilotVoice: (input: { slug: string }) =>
    fetchJson<{ id: string }>("/api/v1/voices/import-postpilot", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  addVoiceSample: (id: string, input: { source: "paste" | "url"; text?: string; url?: string }) =>
    fetchJson<{ ok: true }>(`/api/v1/voices/${id}/samples`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  me: () => fetchJson<{ user: { id: string; email: string; plan: string } }>("/api/v1/account/me"),
  adminMe: () => fetchJson<{ is_admin: boolean }>("/api/v1/admin/me"),
  adminStats: () =>
    fetchJson<{
      users: { total: number; new_7d: number };
      projects: { active: number; deleted: number };
      chapters: { total: number; drafted: number };
      render_jobs: { completed: number; failed: number; running: number };
      compute_spend_cents: number;
      subscription_revenue_cents: number;
      subscription_provider: string;
    }>("/api/v1/admin/stats"),
  adminUsers: (input: { q?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (input.q) sp.set("q", input.q);
    if (input.limit) sp.set("limit", String(input.limit));
    if (input.offset) sp.set("offset", String(input.offset));
    const qs = sp.toString();
    return fetchJson<{
      total: number;
      items: {
        id: string;
        email: string;
        name: string;
        plan: "free" | "pro";
        phase: string;
        is_admin: boolean;
        daily_budget_cents: number;
        createdAt: number;
        updatedAt: number;
        project_count: number;
      }[];
    }>(`/api/v1/admin/users${qs ? `?${qs}` : ""}`);
  },
  adminActivity: () =>
    fetchJson<{
      recent_users: { id: string; email: string; createdAt: number }[];
      recent_projects: {
        id: string;
        title: string;
        type: "fiction" | "nonfiction";
        created_at: number;
        user_id: string;
      }[];
      recent_render_jobs: {
        id: string;
        kind: string;
        status: string;
        cost_cents: number;
        started_at: number;
        project_id: string;
      }[];
    }>("/api/v1/admin/activity"),
  adminToggleAdmin: (userId: string, isAdmin: boolean) =>
    fetchJson<{ ok: true }>(`/api/v1/admin/users/${userId}/admin`, {
      method: "POST",
      body: JSON.stringify({ is_admin: isAdmin }),
    }),
  readAloud: async (id: string): Promise<Blob> => {
    const res = await fetch(withBase(`/api/v1/projects/${id}/tts`), {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `${res.status}: ${(body as { error?: { message?: string } }).error?.message ?? res.statusText}`,
      );
    }
    return res.blob();
  },
  maybeMe: async () => {
    const res = await fetch(withBase("/api/v1/session"), {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `${res.status}: ${(body as { error?: { message?: string } }).error?.message ?? res.statusText}`,
      );
    }
    return res.json() as Promise<{
      user: { id: string; name?: string; email: string; plan?: string } | null;
    }>;
  },
};

export const queryKeys = {
  projects: () => ["projects"] as const,
  deletedProjects: () => ["projects", "deleted"] as const,
  blogs: () => ["blogs"] as const,
  deletedBlogs: () => ["blogs", "deleted"] as const,
  blog: (id: string) => ["blogs", id] as const,
  blogPosts: (id: string) => ["blogs", id, "posts"] as const,
  blogPost: (id: string, postId: string) => ["blogs", id, "posts", postId] as const,
  scripts: () => ["scripts"] as const,
  deletedScripts: () => ["scripts", "deleted"] as const,
  script: (id: string) => ["scripts", id] as const,
  scriptScenes: (id: string) => ["scripts", id, "scenes"] as const,
  scriptScene: (id: string, sceneId: string) => ["scripts", id, "scenes", sceneId] as const,
  emdashToken: () => ["account", "emdash-token"] as const,
  project: (id: string) => ["projects", id] as const,
  projectOutline: (id: string) => ["projects", id, "outline"] as const,
  projectChat: (id: string) => ["projects", id, "chat"] as const,
  fullBook: (id: string) => ["projects", id, "book"] as const,
  publisherPack: (id: string) => ["projects", id, "publisher-pack"] as const,
  renderJobs: (id: string) => ["projects", id, "render-jobs"] as const,
  narrationAuditions: (id: string) => ["projects", id, "narration-auditions"] as const,
  audiobookJobs: (id: string) => ["projects", id, "audiobook-jobs"] as const,
  scoutQueries: () => ["scout", "queries"] as const,
  projectScoutFindings: (id: string) => ["projects", id, "scout-findings"] as const,
  gtmBrief: (id: string) => ["projects", id, "gtm-brief"] as const,
  elevenLabsKey: () => ["account", "elevenlabs-key"] as const,
  chapter: (id: string) => ["chapters", id] as const,
  chapterSections: (id: string) => ["chapters", id, "sections"] as const,
  chapterRevisions: (id: string) => ["chapters", id, "revisions"] as const,
  voices: () => ["voices"] as const,
  postPilotGuides: () => ["voices", "postpilot-guides"] as const,
  voice: (id: string) => ["voices", id] as const,
  me: () => ["me"] as const,
};
