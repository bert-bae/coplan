import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { paths, sanitizeId } from '../shared/paths.ts';

/** Pinned session ids, as the browser sent them. Empty when unreadable. */
export function readPins(): string[] {
  try {
    const raw = JSON.parse(readFileSync(paths.pinnedFile(), 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writePins(ids: string[]): string[] {
  const clean = [...new Set(ids.filter((x) => typeof x === 'string' && x))];
  const file = paths.pinnedFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
  renameSync(tmp, file);
  return clean;
}

/** Folder names of the pinned sessions, to compare with directory entries. */
export function pinnedDirs(): Set<string> {
  return new Set(readPins().map(sanitizeId));
}
