/**
 * Synchronous heap probes for large-repo OOM investigation (#1983).
 *
 * Writes to stderr (not pino) so lines flush under CI=1 / gdb attach.
 * Enabled with `GITNEXUS_DEBUG_HEAP=1` or `GITNEXUS_PROFILE_DEFERRED=1`.
 */

import { parseTruthyEnv } from './env.js';
import { isDeferredResolutionProfileEnabled } from './deferred-resolution-profile.js';

export const isDebugHeapEnabled = (): boolean =>
  parseTruthyEnv(process.env.GITNEXUS_DEBUG_HEAP) || isDeferredResolutionProfileEnabled();

export const heapUsedMb = (): number => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

/** Flush a one-line heap snapshot to stderr. */
export const logHeapProbe = (label: string, detail?: string): void => {
  if (!isDebugHeapEnabled()) return;
  const suffix = detail ? ` ${detail}` : '';
  process.stderr.write(`[gitnexus-heap] ${label} used_mb=${heapUsedMb()}${suffix}\n`);
};
