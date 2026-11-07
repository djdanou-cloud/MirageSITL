// An exclusive lock between processes on one machine, for build steps that cargo's own lock does not cover.
//
// The lock is a file holding its owner's process ID and a unique token. It appears whole and only once because it is created
// by hard-linking a private claim file: link(2) fails if the name exists, whereas create-then-write would leave a moment when
// the owner cannot be read. Node has no flock, so nothing frees the lock when a holder is killed: a waiter that finds the
// owner's process gone removes the lock itself. A reused process ID keeps looking alive; that case ends in the timeout error,
// which names the file.
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export interface ExclusiveLockOptions {
  /** How long to wait for a live owner before failing. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 10;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** The lock's content, or null when no lock exists. */
function readOwner(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function ownerIsGone(owner: string): boolean {
  const pid = Number(owner.split(' ')[0]);
  // Content this module did not write names no process: leave it for the timeout error rather than guess.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    return errorCode(error) === 'ESRCH';
  }
}

/**
 * Removes a lock whose owner is gone. Rename claims the name atomically, so of several waiters one removes it. A waiter that
 * read the old owner late may instead move a lock a faster waiter has just taken, which its content shows, and it puts that one
 * back. Should a third waiter link in during that moment, two holders overlap, and a build copy then fails loudly with ENOENT
 * rather than publish anything: this takes a killed holder and three waiters within microseconds.
 */
function removeGoneOwner(lockPath: string, goneOwner: string, aside: string): void {
  try {
    renameSync(lockPath, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  try {
    if (readFileSync(aside, 'utf8') !== goneOwner) linkSync(aside, lockPath);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  } finally {
    rmSync(aside, { force: true });
  }
}

/** Runs `work` while holding the lock at `lockPath`, whose directory must exist, and releases the lock when `work` ends. */
export function withExclusiveLock<T>(lockPath: string, work: () => T, options: ExclusiveLockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const unique = randomUUID();
  const token = `${process.pid} ${unique}\n`;
  const claim = `${lockPath}.${unique}.claim`;
  const deadline = Date.now() + timeoutMs;
  writeFileSync(claim, token);
  try {
    for (;;) {
      try {
        linkSync(claim, lockPath);
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const owner = readOwner(lockPath);
      if (owner !== null && ownerIsGone(owner)) {
        removeGoneOwner(lockPath, owner, `${claim}.aside`);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for ${lockPath}, held by "${owner?.trim() ?? 'nobody'}". Delete the file if no build is running.`);
      }
      Atomics.wait(sleepCell, 0, 0, pollMs);
    }
  } finally {
    rmSync(claim, { force: true });
  }
  try {
    return work();
  } finally {
    // A waiter can have moved this lock aside for a moment; never remove a lock that is no longer this holder's.
    if (readOwner(lockPath) === token) rmSync(lockPath, { force: true });
  }
}
