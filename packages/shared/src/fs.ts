import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJsonFile(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (mode !== undefined) {
    await chmod(path, mode);
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function copyDirectory(
  from: string,
  to: string,
  options?: { filter?: (src: string, dest: string) => boolean | Promise<boolean> }
): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true, preserveTimestamps: true, filter: options?.filter });
}

export async function atomicSymlink(target: string, linkPath: string): Promise<void> {
  const tempPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  await rm(tempPath, { recursive: true, force: true });
  await symlink(target, tempPath, "dir");
  await rename(tempPath, linkPath);
}

export async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory: ${path}`);
  }
}

export function outpostDir(projectRoot: string): string {
  return join(projectRoot, ".outpost");
}
