import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

/** A refusal with a status the client should see, rather than a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

/** A tiny path router: `/api/session/:id/plan/ops`. */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(':')) {
          try {
            params[seg.slice(1)] = decodeURIComponent(part);
          } catch {
            throw new HttpError(400, 'malformed path');
          }
        }
        else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

/** On every response: never sniff a type, never leak the URL (the first page
 *  load carries the auth token in its query string), never be framed. */
export const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
} as const;

/**
 * The UI's content policy. Everything is served from the daemon itself;
 * React Flow positions nodes with inline styles, so styles need
 * 'unsafe-inline', but scripts never do.
 */
export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** A plan is bounded well below this; anything larger is not a real request. */
const MAX_BODY = 2 * 1024 * 1024;

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  if (!body.trim()) return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, 'malformed JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'expected a JSON object');
  return parsed as T;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve a file from `rootDir`, refusing anything that escapes it. */
export function serveStatic(res: ServerResponse, rootDir: string, relPath: string): boolean {
  const clean = relPath.replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(rootDir, clean);
  if (!file.startsWith(path.resolve(rootDir) + path.sep) && file !== path.resolve(rootDir, 'index.html')) {
    return false;
  }
  if (!existsSync(file)) return false;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(file);
  res.writeHead(200, {
    ...BASE_HEADERS,
    ...(ext === '.html' ? { 'content-security-policy': UI_CSP } : {}),
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });

  // `pipe` does not tear the source down when the destination closes early,
  // so a browser that navigates away mid-response would leave the descriptor
  // open until the whole file had been read. Close it explicitly.
  const stream = createReadStream(file);
  const done = () => stream.destroy();
  res.on('close', done);
  res.on('error', done);
  stream.on('error', () => {
    res.off('close', done);
    if (!res.writableEnded) res.end();
  });
  stream.on('end', () => res.off('close', done));
  stream.pipe(res);
  return true;
}
