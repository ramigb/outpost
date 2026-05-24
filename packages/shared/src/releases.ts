import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseMetadata } from "@outpost/protocol";
import { outpostPaths } from "./config.js";
import { atomicSymlink, copyDirectory, ensureDir } from "./fs.js";

export function formatReleaseId(createdAt: Date, commit: string): string {
  const timestamp = createdAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${commit.slice(0, 7)}`;
}

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

export async function publishRelease(input: {
  projectRoot: string;
  releaseId: string;
  outputDir: string;
  metadata: ReleaseMetadata;
  filter?: (src: string, dest: string) => boolean | Promise<boolean>;
}): Promise<void> {
  const paths = outpostPaths(input.projectRoot);
  const releaseDir = join(paths.releases, input.releaseId);
  await copyDirectory(input.outputDir, releaseDir, { filter: input.filter });
  await writeFile(join(releaseDir, "release.json"), `${JSON.stringify(input.metadata, null, 2)}\n`);
  await atomicSymlink(releaseDir, paths.live);
}

export async function rollbackToRelease(projectRoot: string, releaseId: string): Promise<void> {
  const paths = outpostPaths(projectRoot);
  const releaseDir = join(paths.releases, releaseId);
  const stat = await lstat(releaseDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Release does not exist: ${releaseId}`);
  }
  await atomicSymlink(releaseDir, paths.live);
}

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
