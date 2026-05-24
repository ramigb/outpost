import { pathExists, writeJsonFile } from "@outpost/shared";
import {
  createDefaultOutpostConfig,
  ensureSigningKeyPair,
  initializeOutpostDirectories,
  outpostPaths,
  saveOutpostConfig,
  saveOutpostState
} from "@outpost/shared";

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
