import { readFile, writeFile } from "node:fs/promises";
import { decodeJsonBase64, parsePairingPayload } from "@outpost/protocol";
import {
  ensureSigningKeyPair,
  initializeOutpostDirectories,
  loadOutpostConfig,
  outpostPaths,
  peerIdFromPublicKey,
  saveOutpostConfig,
  saveOutpostState
} from "@outpost/shared";
import { initOutpost } from "./init.js";

export async function linkOutpost(
  payloadBase64: string,
  projectRoot = process.cwd()
): Promise<{ outpostPeerId: string; mothershipPeerId: string }> {
  await initOutpost(projectRoot);
  await saveOutpostState(projectRoot, { state: "PAIRING" });

  const payload = parsePairingPayload(decodeJsonBase64(payloadBase64));
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error("Pairing token has expired. Generate a new setup command in Mothership.");
  }
  const paths = outpostPaths(projectRoot);
  await initializeOutpostDirectories(projectRoot);
  await writeFile(paths.mothershipPublicKey, payload.mothershipPublicKey, { mode: 0o644 });

  const config = await loadOutpostConfig(projectRoot);
  await saveOutpostConfig(projectRoot, {
    ...config,
    beaconUrl: payload.beaconUrl,
    pairingNonce: payload.pairingNonce,
    projectName: payload.buildHints?.projectName ?? payload.displayName ?? config.projectName,
    installCommand: payload.buildHints?.installCommand ?? config.installCommand,
    buildCommand: payload.buildHints?.buildCommand ?? config.buildCommand,
    outputDir: payload.buildHints?.outputDir ?? config.outputDir,
    retainReleases: payload.buildHints?.retainReleases ?? config.retainReleases
  });

  const outpostKeys = await ensureSigningKeyPair(paths.outpostPrivateKey, paths.outpostPublicKey);
  const outpostPeerId = peerIdFromPublicKey(outpostKeys.publicKeyPem);
  const mothershipPeerId = peerIdFromPublicKey(await readFile(paths.mothershipPublicKey, "utf8"));
  await saveOutpostState(projectRoot, { state: "PAIRED_OFFLINE" });
  return { outpostPeerId, mothershipPeerId };
}
