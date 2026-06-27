/**
 * Cross-platform file lock via exclusive-create semantics.
 *
 * Windows lacks POSIX flock; this uses open with O_EXCL (wx flag)
 * which works on all platforms. Falls back gracefully when the lock
 * directory doesn't exist.
 */

import { openSync, closeSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "./logger.js";

export interface Lock {
  release(): void;
}

const LOCKS = new Set<string>();

/**
 * Acquire an exclusive lock file. Retries with backoff up to maxWaitMs.
 * The lock file path is `<lockDir>/<name>.lock`.
 */
export function acquireLock(
  lockDir: string,
  name: string,
  log: Logger,
  maxWaitMs = 10_000,
): Lock | null {
  const dir = resolve(lockDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lockPath = resolve(dir, `${name}.lock`);
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < maxWaitMs) {
    attempts++;
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      LOCKS.add(lockPath);
      return {
        release: () => {
          try { unlinkSync(lockPath); } catch { /* best effort */ }
          LOCKS.delete(lockPath);
        },
      };
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      // EEXIST means lock held; wait and retry
      if (nodeErr.code === "EEXIST") {
        // Random backoff 20-100ms to reduce thundering herd
        const delay = 20 + Math.floor(Math.random() * 80);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        continue;
      }
      // Unexpected error
      log.warn(`Lock acquire failed (non-EEXIST): ${(err as Error).message}`);
      return null;
    }
  }

  log.warn(`Lock timeout after ${maxWaitMs}ms (${attempts} attempts): ${lockPath}`);
  return null;
}

/** Release all locks. Idempotent. Safe to call at exit. */
export function releaseAll(): void {
  for (const lockPath of LOCKS) {
    try { unlinkSync(lockPath); } catch { /* ok */ }
  }
  LOCKS.clear();
}
