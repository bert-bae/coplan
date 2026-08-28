/** Formatting helpers shared across views. */

export function relativeTime(ts: number, now = Date.now()): string {
  const delta = Math.max(0, now - ts);
  const seconds = Math.round(delta / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "4m 12s" — for how long Claude has been blocked on the user. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Split a path into its directory and file name for two-tone rendering. */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/');
  if (index < 0) return { dir: '', name: path };
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

/** `src/app.ts:12-14` or `src/app.ts:12`. */
export function lineRef(file: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${file}:${startLine}` : `${file}:${startLine}-${endLine}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function classNames(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
