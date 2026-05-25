/**
 * @module @outpost/daemon/init
 *
 * One-time initialisation of an Outpost project: creates the `.outpost/`
 * directory structure, generates signing keys, and writes a default config.
 */

import { pathExists, writeJsonFile } from "@outpost/shared";
import {
  createDefaultOutpostConfig,
  ensureSigningKeyPair,
  initializeOutpostDirectories,
  outpostPaths,
  saveOutpostConfig,
  saveOutpostState
} from "@outpost/shared";

/**
 * Initialises an Outpost project in the given directory.
 *
 * @param projectRoot - Directory to initialise. Defaults to `process.cwd()`.
 *
 * @remarks
 * This is safe to run multiple times: it only creates files that are missing.
 */
export async function initOutpost(projectRoot = process.cwd()): Promise<void> {
  const paths = outpostPaths(projectRoot);
  await initializeOutpostDirectories(projectRoot);
  if (!(await pathExists(paths.config))) {
    await saveOutpostConfig(projectRoot, await createDefaultOutpostConfig(projectRoot));
  }
  await ensureSigningKeyPair(paths.outpostPrivateKey, paths.outpostPublicKey);
  if (!(await pathExists(paths.state))) {
    await saveOutpostState(projectRoot, { state: "UNPAIRED" });
  }
  await writeJsonFile(`${paths.logs}/.keep`, {});
}
