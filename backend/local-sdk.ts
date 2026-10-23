import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { hashSessionToken } from './security';

export type LocalUser = {
  userId: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
};

export type RouteContext = {
  body?: unknown;
  query: Record<string, string | string[] | undefined>;
  user?: LocalUser | null;
  request: IncomingMessage;
  [key: string]: unknown;
};

export type RouteHandler = (context: RouteContext) => unknown | Promise<unknown>;

type LocalResponse = { status: number; body: unknown; headers?: Record<string, string> };
class RequestBodyTooLargeError extends Error {}

const databasePath = resolve(process.env.GAMETRACKER_DB_PATH || './data/gametracker.db');
const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE IF NOT EXISTS records (
    table_name TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (table_name, id)
  );
  CREATE INDEX IF NOT EXISTS records_table_created ON records(table_name, created_at);
`);

export const db = {
  async list<T extends Record<string, unknown> = Record<string, unknown>>(table: string, options: { limit?: number; nextToken?: string } = {}) {
    const offset = Number(options.nextToken || 0);
    const limit = Math.max(1, options.limit || 100);
    const rows = database.prepare('SELECT id, payload FROM records WHERE table_name = ? ORDER BY created_at ASC LIMIT ? OFFSET ?').all(table, limit, offset) as Array<{ id: string; payload: string }>;
    const items = rows.map(row => ({ ...(JSON.parse(row.payload) as T), id: row.id }));
    return { items, nextToken: items.length === limit ? String(offset + items.length) : undefined };
  },
  async add<T extends Record<string, unknown>>(table: string, records: T[]) {
    const insert = database.prepare('INSERT INTO records (table_name, id, payload, created_at) VALUES (?, ?, ?, ?)');
    return records.map(record => {
      const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      insert.run(table, id, JSON.stringify(record), Date.now());
      return id;
    });
  },
  async update<T extends Record<string, unknown>>(table: string, records: Array<{ id: string; record: T }>) {
    const update = database.prepare('UPDATE records SET payload = ? WHERE table_name = ? AND id = ?');
    return records.map(({ id, record }) => Number(update.run(JSON.stringify(record), table, id).changes) > 0);
  },
  async delete(table: string, ids: string[]) {
    const remove = database.prepare('DELETE FROM records WHERE table_name = ? AND id = ?');
    return ids.map(id => Number(remove.run(table, id).changes) > 0);
  },
};

export function json<T>(data: T, init?: { status?: number; headers?: Record<string, string> }): LocalResponse {
  return { status: init?.status || 200, body: data, headers: init?.headers };
}

export function error(message: string, status = 400): LocalResponse {
  return { status, body: { error: message } };
}

export function requireAuth(): RouteHandler {
  return ({ user }) => user ? undefined : error('Authentication required.', 401);
}

async function requestBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function normalizeResponse(value: unknown): LocalResponse {
  if (value && typeof value === 'object' && 'status' in value && 'body' in value) return value as LocalResponse;
  return { status: 200, body: value ?? { ok: true } };
}

export function router(routes: Record<string, RouteHandler[]>) {
  return async (request: IncomingMessage): Promise<LocalResponse> => {
    const url = new URL(request.url || '/', 'http://localhost');
    const route = routes[`${request.method || 'GET'} ${url.pathname}`];
    if (!route) return error('Route not found.', 404);
    const query: Record<string, string | string[] | undefined> = {};
    url.searchParams.forEach((value, key) => { query[key] = value; });
    const cookieHeader = String(request.headers.cookie || '');
    const sessionToken = cookieHeader.split(';').map(cookie => cookie.trim()).find(cookie => cookie.startsWith('gt_session='))?.slice('gt_session='.length) || '';
    const sessions = sessionToken ? await db.list<{ token?: string; tokenHash?: string; userId?: string; name?: string; email?: string; createdAt?: string; expiresAt?: string }>('auth_sessions', { limit: 1000 }) : { items: [] };
    const sessionHash = sessionToken ? hashSessionToken(sessionToken) : '';
    const session = sessions.items.find(item => item.tokenHash === sessionHash || item.token === sessionToken);
    const explicitExpiry = Date.parse(session?.expiresAt || '');
    const createdAt = Date.parse(session?.createdAt || '');
    const sessionExpiry = Number.isFinite(explicitExpiry)
      ? explicitExpiry
      : Number.isFinite(createdAt) ? createdAt + AUTH_SESSION_TTL_MS : 0;
    const sessionIsValid = Boolean(session?.userId && sessionExpiry > Date.now());
    if (session && !sessionIsValid && session.id) await db.delete('auth_sessions', [session.id]);
    if (sessionIsValid && session?.token && session.id) {
      const { id, token: _legacyToken, ...record } = session;
      await db.update('auth_sessions', [{ id, record: { ...record, tokenHash: sessionHash } }]);
    }
    const user = sessionIsValid && session?.userId ? { userId: session.userId, name: session.name || '', email: session.email || '' } : null;
    let body: unknown;
    try {
      body = await requestBody(request, url.pathname.startsWith('/api/auth/') ? 64 * 1024 : 10 * 1024 * 1024);
    } catch (cause) {
      if (cause instanceof RequestBodyTooLargeError) return error('Request body is too large.', 413);
      return error('Unable to read request body.', 400);
    }
    const context: RouteContext = { body, query, user, request };
    for (const handler of route) {
      const result = await handler(context);
      if (result !== undefined) return normalizeResponse(result);
    }
    return json({ ok: true });
  };
}

export const ws = {
  async send(_connectionIds: string[], _message: unknown) {
    return undefined;
  },
};
