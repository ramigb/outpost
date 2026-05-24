import { appendFile, mkdir, stat, rename, truncate } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

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
