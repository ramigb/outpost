/**
 * @module @outpost/shared/logging
 *
 * Simple append-only log writer with automatic rotation when a size threshold
 * is exceeded.
 */

import { appendFile, mkdir, stat, rename, truncate } from "node:fs/promises";
import { dirname } from "node:path";

/** Default maximum log file size before rotation: 50 MB. */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Appends a single line to a log file, rotating the file first if it has grown
 * beyond `maxBytes`.
 *
 * @param path - Log file path.
 * @param line - Raw text line (a trailing newline is added automatically).
 * @param maxBytes - Size threshold before rotation. Defaults to 50 MB.
 */
export async function appendLogLine(
  path: string,
  line: string,
  maxBytes = DEFAULT_MAX_BYTES
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rotateIfNeeded(path, maxBytes);
  await appendFile(path, `${new Date().toISOString()} ${line}\n`, "utf8");
}

async function rotateIfNeeded(path: string, maxBytes: number): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info || info.size < maxBytes) {
    return;
  }
  const rotated = `${path}.1`;
  await rename(path, rotated).catch(async () => {
    await truncate(path, 0);
  });
}
