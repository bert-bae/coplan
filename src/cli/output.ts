/**
 * Whether stdout, where a command's report goes, could not be written.
 * Nothing left reading it (`coplan check | head`, an agent that closed the
 * pipe: EPIPE; a terminal closed: EIO) is no failure: what cannot be written
 * is let go. Any other (a full disk under `--json > report.json`) is: the
 * command ends as a failure (main's exit), and one that runs things stops
 * before the next (check). Told a tick after the write that failed, and a
 * stream to a file keeps no record of it, so it is kept here.
 */
let unwritten: NodeJS.ErrnoException | undefined;

export function stdoutFailure(): NodeJS.ErrnoException | undefined {
  return unwritten;
}

/** Watch stdout; `onFailure` is called once, on the first failure. */
export function watchStdout(onFailure: () => void): void {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'EIO' || unwritten) return;
    unwritten = err;
    onFailure();
  });
}
