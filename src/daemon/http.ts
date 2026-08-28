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

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

/** A tiny path router: `/api/session/:id/gate/:gateId/resolve`. */
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
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
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

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const MAX_BODY = 8 * 1024 * 1024;

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
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
  return JSON.parse(body) as T;
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

  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
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

/**
 * An AbortSignal that fires when the client hangs up mid-long-poll.
 *
 * This is what stops a killed hook relay or a closed browser tab from leaving
 * a waiter parked in the daemon for its full nine-minute window.
 */
export function requestSignal(req: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    req.off('close', abort);
    req.off('aborted', abort);
    if (!controller.signal.aborted) controller.abort();
  };
  req.on('close', abort);
  req.on('aborted', abort);
  return controller.signal;
}
