/**
 * @module @outpost/shared/releases
 *
 * Release management helpers: formatting release IDs, listing, publishing,
 * rolling back, and pruning old releases.
 */

import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseMetadata } from "@outpost/protocol";
import { outpostPaths } from "./config.js";
import { atomicSymlink, copyDirectory, ensureDir } from "./fs.js";

/**
 * Generates a sortable release identifier from a timestamp and commit SHA.
 *
 * @param createdAt - Build completion time.
 * @param commit - Full or short Git commit SHA.
 * @returns Release ID in the form `<iso-timestamp>-<short-commit>`.
 */
export function formatReleaseId(createdAt: Date, commit: string): string {
  const timestamp = createdAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${commit.slice(0, 7)}`;
}

/**
 * Lists all releases stored under `.outpost/releases/`.
 *
 * @param projectRoot - Directory of the managed project.
 * @returns Sorted array of `ReleaseMetadata` (oldest first).
 */
export async function listReleases(projectRoot: string): Promise<ReleaseMetadata[]> {
  const paths = outpostPaths(projectRoot);
  const names = await readdir(paths.releases).catch(() => []);
  const releases: ReleaseMetadata[] = [];
  for (const name of names) {
    const metadataPath = join(paths.releases, name, "release.json");
    try {
      releases.push(JSON.parse(await readFile(metadataPath, "utf8")) as ReleaseMetadata);
    } catch {
      continue;
    }
  }
  return releases.sort((a, b) => a.releaseId.localeCompare(b.releaseId));
}

/**
 * Publishes a release by copying build output into `.outpost/releases/<id>/`
 * and atomically updating the `.outpost/live` symlink.
 *
 * @param input - Release publish parameters.
 */
export async function publishRelease(input: {
  projectRoot: string;
  releaseId: string;
  outputDir: string;
  metadata: ReleaseMetadata;
  /** Optional filter applied while copying. */
  filter?: (src: string, dest: string) => boolean | Promise<boolean>;
}): Promise<void> {
  const paths = outpostPaths(input.projectRoot);
  const releaseDir = join(paths.releases, input.releaseId);
  await copyDirectory(input.outputDir, releaseDir, { filter: input.filter });
  await writeFile(join(releaseDir, "release.json"), `${JSON.stringify(input.metadata, null, 2)}\n`);
  await atomicSymlink(releaseDir, paths.live);
}

/**
 * Rolls back the live symlink to a previous release without rebuilding.
 *
 * @param projectRoot - Directory of the managed project.
 * @param releaseId - Existing release ID to restore.
 * @throws Error when the release directory does not exist.
 */
export async function rollbackToRelease(projectRoot: string, releaseId: string): Promise<void> {
  const paths = outpostPaths(projectRoot);
  const releaseDir = join(paths.releases, releaseId);
  const stat = await lstat(releaseDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Release does not exist: ${releaseId}`);
  }
  await atomicSymlink(releaseDir, paths.live);
}

/**
 * Prunes old successful releases, keeping at most `retain` on disk.
 *
 * @param projectRoot - Directory of the managed project.
 * @param retain - Number of successful releases to keep.
 * @param activeReleaseId - Currently active release that must never be deleted.
 */
export async function pruneReleases(
  projectRoot: string,
  retain: number,
  activeReleaseId?: string
): Promise<void> {
  const releases = await listReleases(projectRoot);
  const successful = releases.filter((release) => release.status === "success");
  const remove = successful.slice(0, Math.max(0, successful.length - retain));
  const paths = outpostPaths(projectRoot);
  await ensureDir(paths.releases);
  for (const release of remove) {
    if (release.releaseId !== activeReleaseId) {
      await rm(join(paths.releases, release.releaseId), { recursive: true, force: true });
    }
  }
}
