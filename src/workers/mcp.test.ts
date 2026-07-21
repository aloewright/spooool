import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeMcpRequest,
  createSpoooolMcpServer,
  handleSpoooolMcpRequest,
  resolveMcpOwner,
  timingSafeTokenEqual,
  type SpoooolMcpEnv,
  type SpoooolMcpOwner,
} from './mcp';

const owner: SpoooolMcpOwner = {
  id: 'user-1',
  email: 'owner@example.com',
  name: 'Owner',
  username: 'owner',
};

const closeables: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
});

function database(
  run: (sql: string, bindings: unknown[], mode: 'first' | 'all') => unknown,
): D1Database {
  return {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async first<T>() {
          return (run(sql, bindings, 'first') ?? null) as T | null;
        },
        async all<T>() {
          return {
            success: true,
            results: (run(sql, bindings, 'all') ?? []) as T[],
            meta: {},
          };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe('Spooool MCP authorization', () => {
  it('compares tokens without short-circuiting on length or content', () => {
    expect(timingSafeTokenEqual('correct-token', 'correct-token')).toBe(true);
    expect(timingSafeTokenEqual('correct-token', 'wrong-token')).toBe(false);
    expect(timingSafeTokenEqual('short', 'much-longer-token')).toBe(false);
  });

  it('rejects untrusted browser origins before checking credentials', () => {
    const result = authorizeMcpRequest(
      new Request('https://spooool.com/mcp', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      }),
      { DB: {} as D1Database, MCP_SERVER_TOKEN: 'secret' },
    );
    expect(result.authorized).toBe(false);
    if (!result.authorized) expect(result.response.status).toBe(403);
  });

  it('allows trusted preflight requests and server-to-server bearer auth', () => {
    const preflight = authorizeMcpRequest(
      new Request('https://spooool.com/mcp', {
        method: 'OPTIONS',
        headers: { Origin: 'https://alex.chat' },
      }),
      { DB: {} as D1Database, MCP_SERVER_TOKEN: 'secret' },
    );
    expect(preflight.authorized).toBe(false);
    if (!preflight.authorized) {
      expect(preflight.response.status).toBe(204);
      expect(preflight.response.headers.get('access-control-allow-origin')).toBe(
        'https://alex.chat',
      );
    }

    const authorized = authorizeMcpRequest(
      new Request('https://spooool.com/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      }),
      { DB: {} as D1Database, MCP_SERVER_TOKEN: 'secret' },
    );
    expect(authorized.authorized).toBe(true);
  });

  it('returns 401 for a missing or incorrect bearer token', () => {
    const result = authorizeMcpRequest(
      new Request('https://spooool.com/mcp', { method: 'POST' }),
      { DB: {} as D1Database, MCP_SERVER_TOKEN: 'secret' },
    );
    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get('www-authenticate')).toContain('Bearer');
    }
  });
});

describe('Spooool MCP owner scoping', () => {
  it('resolves the configured owner case-insensitively', async () => {
    const calls: unknown[][] = [];
    const env: SpoooolMcpEnv = {
      MCP_OWNER_EMAIL: 'Owner@Example.com',
      DB: database((_sql, bindings, mode) => {
        calls.push(bindings);
        return mode === 'first' ? owner : [];
      }),
    };

    await expect(resolveMcpOwner(env)).resolves.toEqual(owner);
    expect(calls).toEqual([['Owner@Example.com']]);
  });

  it('exposes only focused read-only tools and binds private reads to the owner', async () => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const env: SpoooolMcpEnv = {
      DB: database((sql, bindings, mode) => {
        calls.push({ sql, bindings });
        if (mode === 'first' && sql.includes('FROM videos v')) {
          return { id: 'video-1', title: 'Owner video' };
        }
        return [];
      }),
    };
    const server = createSpoooolMcpServer(env, owner);
    const client = new Client({ name: 'spooool-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'get_account_overview',
      'list_my_videos',
      'get_my_video',
      'search_public_videos',
      'list_generated_assets',
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

    const result = await client.callTool({
      name: 'get_my_video',
      arguments: { videoId: 'video-1' },
    });
    expect(result.isError).not.toBe(true);
    expect(calls.at(-1)?.bindings).toEqual(['video-1', owner.id]);
  });
});

describe('Spooool MCP Streamable HTTP endpoint', () => {
  it('completes an authenticated MCP initialize handshake', async () => {
    const env: SpoooolMcpEnv = {
      MCP_SERVER_TOKEN: 'secret',
      MCP_OWNER_EMAIL: owner.email,
      DB: database((_sql, _bindings, mode) => (mode === 'first' ? owner : [])),
    };
    const response = await handleSpoooolMcpRequest(
      new Request('https://spooool.com/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
          Origin: 'https://alex.chat',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'agent.fly.pm', version: '1.0.0' },
          },
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://alex.chat');
    const payload = (await response.json()) as {
      result?: { serverInfo?: { name?: string }; protocolVersion?: string };
    };
    expect(payload.result?.serverInfo?.name).toBe('spooool');
    expect(payload.result?.protocolVersion).toBe('2025-11-25');
  });
});
