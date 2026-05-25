/**
 * @module @outpost/shared/fs
 *
 * Filesystem helpers used across the monorepo: atomic symlinks, safe JSON
 * read/write, directory copying, and path existence checks.
 */

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

/**
 * Checks whether a path exists on the filesystem.
 *
 * @param path - Filesystem path to test.
 * @returns `true` when the path is accessible, `false` otherwise.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a JSON file and parses it.
 *
 * @param path - Filesystem path to the JSON file.
 * @returns Parsed value cast to the caller's type parameter.
 * @throws Error when the file is missing or contains invalid JSON.
 */
export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/**
 * Writes a value as formatted JSON to a file, optionally setting POSIX permissions.
 *
 * @param path - Destination filesystem path.
 * @param value - Value to serialise.
 * @param mode - Optional POSIX file mode (e.g. `0o600`).
 */
export async function writeJsonFile(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (mode !== undefined) {
    await chmod(path, mode);
  }
}

/**
 * Ensures a directory exists, creating it recursively when necessary.
 *
 * @param path - Directory path.
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Recursively copies a directory, optionally filtering entries.
 *
 * @param from - Source directory.
 * @param to - Destination directory.
 * @param options - Optional copy filter.
 */
export async function copyDirectory(
  from: string,
  to: string,
  options?: { filter?: (src: string, dest: string) => boolean | Promise<boolean> }
): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true, preserveTimestamps: true, filter: options?.filter });
}

/**
 * Atomically replaces a directory symlink by creating a temporary symlink
 * and renaming it over the old one.
 *
 * @param target - Target directory the symlink should point to.
 * @param linkPath - Path where the symlink lives (or will be created).
 *
 * @remarks
 * This avoids a window where `linkPath` does not exist or points to an
 * intermediate state.
 */
export async function atomicSymlink(target: string, linkPath: string): Promise<void> {
  const tempPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  await rm(tempPath, { recursive: true, force: true });
  await symlink(target, tempPath, "dir");
  await rename(tempPath, linkPath);
}

/**
 * Asserts that a path exists and is a directory.
 *
 * @param path - Path to validate.
 * @param label - Human-readable label for error messages.
 * @throws Error when the path is missing or not a directory.
 */
export async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory: ${path}`);
  }
}

/**
 * Returns the conventional `.outpost/` directory path inside a project.
 *
 * @param projectRoot - Root directory of the managed project.
 * @returns Absolute path to `.outpost/`.
 */
export function outpostDir(projectRoot: string): string {
  return join(projectRoot, ".outpost");
}
