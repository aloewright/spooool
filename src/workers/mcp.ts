import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { buildFtsQuery } from './search';

const MCP_SERVER_NAME = 'spooool';
const MCP_SERVER_VERSION = '1.0.0';
const MCP_RESOURCE = new URL('https://spooool.com/mcp');
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://alex.chat',
  'https://spooool.com',
]);

export interface SpoooolMcpEnv {
  DB: D1Database;
  MCP_SERVER_TOKEN?: string;
  MCP_OWNER_EMAIL?: string;
  MCP_ALLOWED_ORIGINS?: string;
}

export interface SpoooolMcpOwner {
  id: string;
  email: string;
  name: string;
  username: string | null;
}

type AuthorizationResult =
  | { authorized: true; token: string; origin: string | null }
  | { authorized: false; response: Response };

function jsonContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

export function timingSafeTokenEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let difference = aBytes.length ^ bBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }

  return difference === 0;
}

function parseBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function allowedOrigins(env: SpoooolMcpEnv): Set<string> {
  const configured = env.MCP_ALLOWED_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured?.length ? new Set(configured) : DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    Vary: 'Origin',
  };
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function authorizeMcpRequest(
  request: Request,
  env: SpoooolMcpEnv,
): AuthorizationResult {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins(env).has(origin)) {
    return {
      authorized: false,
      response: new Response('Forbidden origin', { status: 403 }),
    };
  }

  if (request.method === 'OPTIONS') {
    return {
      authorized: false,
      response: new Response(null, { status: 204, headers: corsHeaders(origin) }),
    };
  }

  if (!env.MCP_SERVER_TOKEN) {
    return {
      authorized: false,
      response: withCors(new Response('MCP is not configured', { status: 503 }), origin),
    };
  }

  const token = parseBearerToken(request);
  if (!token || !timingSafeTokenEqual(token, env.MCP_SERVER_TOKEN)) {
    return {
      authorized: false,
      response: withCors(
        new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="spooool-mcp"' },
        }),
        origin,
      ),
    };
  }

  return { authorized: true, token, origin };
}

export async function resolveMcpOwner(
  env: SpoooolMcpEnv,
): Promise<SpoooolMcpOwner | null> {
  const email = env.MCP_OWNER_EMAIL?.trim();
  if (!email) return null;

  return env.DB.prepare(
    `SELECT id, email, name, username
       FROM user
      WHERE lower(email) = lower(?)
      LIMIT 1`,
  )
    .bind(email)
    .first<SpoooolMcpOwner>();
}

export function createSpoooolMcpServer(
  env: SpoooolMcpEnv,
  owner: SpoooolMcpOwner,
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'get_account_overview',
    {
      title: 'Get Spooool account overview',
      description:
        'Summarize the connected Spooool account, including video, view, storage, Studio asset, and AI spend totals.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = await env.DB.prepare(
        `SELECT
           COUNT(DISTINCT v.id) AS video_count,
           COALESCE(SUM(v.view_count), 0) AS total_views,
           COALESCE(SUM(v.bytes), 0) AS video_bytes,
           (SELECT COUNT(*) FROM generated_assets ga WHERE ga.user_id = ?1) AS generated_asset_count,
           (SELECT COALESCE(SUM(ga.bytes), 0) FROM generated_assets ga WHERE ga.user_id = ?1) AS generated_asset_bytes,
           (SELECT COALESCE(SUM(ac.est_usd), 0) FROM ai_costs ac WHERE ac.user_id = ?1) AS estimated_ai_spend_usd
         FROM videos v
         WHERE v.user_id = ?1 AND v.deleted_at IS NULL`,
      )
        .bind(owner.id)
        .first<Record<string, unknown>>();

      return jsonContent({ account: owner, ...result });
    },
  );

  server.registerTool(
    'list_my_videos',
    {
      title: 'List my Spooool videos',
      description:
        'List videos owned by the connected Spooool account, newest first, with status and performance metadata.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        status: z.string().trim().min(1).max(32).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, status }) => {
      const statusClause = status ? 'AND v.status = ?3' : '';
      const statement = env.DB.prepare(
        `SELECT v.id, v.title, v.description, v.status, v.view_count,
                v.thumbnail_url, v.playback_hls_url, v.ai_generated,
                v.created_at, v.updated_at
           FROM videos v
          WHERE v.user_id = ?1 AND v.deleted_at IS NULL ${statusClause}
          ORDER BY v.created_at DESC
          LIMIT ?2`,
      );
      const query = status
        ? statement.bind(owner.id, limit, status)
        : statement.bind(owner.id, limit);
      const { results } = await query.all();
      return jsonContent({ videos: results, count: results.length });
    },
  );

  server.registerTool(
    'get_my_video',
    {
      title: 'Get my Spooool video',
      description:
        'Get detailed metadata for one video owned by the connected Spooool account.',
      inputSchema: { videoId: z.string().trim().min(1).max(128) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ videoId }) => {
      const video = await env.DB.prepare(
        `SELECT v.id, v.title, v.description, v.status, v.view_count,
                v.thumbnail_url, v.playback_hls_url, v.stream_video_id,
                v.bytes, v.ai_generated, v.source_video_id, v.hidden_at,
                v.dmca_status, v.created_at, v.updated_at
           FROM videos v
          WHERE v.id = ?1 AND v.user_id = ?2 AND v.deleted_at IS NULL
          LIMIT 1`,
      )
        .bind(videoId, owner.id)
        .first<Record<string, unknown>>();

      return video ? jsonContent({ video }) : errorContent('Video not found.');
    },
  );

  server.registerTool(
    'search_public_videos',
    {
      title: 'Search public Spooool videos',
      description: 'Search ready, publicly visible Spooool videos by title and description.',
      inputSchema: {
        query: z.string().trim().min(1).max(120),
        limit: z.number().int().min(1).max(25).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const ftsQuery = buildFtsQuery(query);
      if (!ftsQuery) return jsonContent({ query, videos: [], count: 0 });

      const { results } = await env.DB.prepare(
        `SELECT v.id, v.title, v.description, v.thumbnail_url, v.view_count,
                v.created_at, u.name AS channel_name, u.username AS channel_username,
                videos_fts.rank AS rank
           FROM videos_fts
           JOIN videos v ON v.id = videos_fts.video_id
           LEFT JOIN user u ON u.id = v.user_id
          WHERE videos_fts MATCH ?1
            AND v.status = 'ready'
            AND v.deleted_at IS NULL
            AND v.hidden_at IS NULL
            AND (v.dmca_status IS NULL OR v.dmca_status = 'active')
          ORDER BY rank
          LIMIT ?2`,
      )
        .bind(ftsQuery, limit)
        .all();
      return jsonContent({ query, videos: results, count: results.length });
    },
  );

  server.registerTool(
    'list_generated_assets',
    {
      title: 'List generated Spooool Studio assets',
      description:
        'List AI Studio assets owned by the connected Spooool account, including type, source, status, size, and timestamps.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        kind: z.enum(['image', 'video', 'audio', 'caption', 'metadata', 'clip']).optional(),
        status: z.enum(['queued', 'processing', 'ready', 'failed']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, kind, status }) => {
      const clauses = ['user_id = ?1'];
      const bindings: Array<string | number> = [owner.id];
      if (kind) {
        bindings.push(kind);
        clauses.push(`kind = ?${bindings.length}`);
      }
      if (status) {
        bindings.push(status);
        clauses.push(`status = ?${bindings.length}`);
      }
      bindings.push(limit);

      const { results } = await env.DB.prepare(
        `SELECT id, kind, source, stream_video_id, bytes, status,
                error_message, project_id, created_at, updated_at
           FROM generated_assets
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ?${bindings.length}`,
      )
        .bind(...bindings)
        .all();
      return jsonContent({ assets: results, count: results.length });
    },
  );

  return server;
}

export async function handleSpoooolMcpRequest(
  request: Request,
  env: SpoooolMcpEnv,
): Promise<Response> {
  const authorization = authorizeMcpRequest(request, env);
  if (!authorization.authorized) return authorization.response;

  const owner = await resolveMcpOwner(env);
  if (!owner) {
    return withCors(
      new Response('MCP owner is not configured or does not exist', { status: 503 }),
      authorization.origin,
    );
  }

  const server = createSpoooolMcpServer(env, owner);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const response = await transport.handleRequest(request, {
    authInfo: {
      token: '[redacted]',
      clientId: 'agent.fly.pm',
      scopes: ['spooool:read'],
      resource: MCP_RESOURCE,
    },
  });
  return withCors(response, authorization.origin);
}
