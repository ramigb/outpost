import { homedir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  encodeJsonBase64,
  type OutpostStatusReport,
  type PairingPayload
} from "@outpost/protocol";
import {
  ensureDir,
  ensureSigningKeyPair,
  pathExists,
  peerIdFromPublicKey,
  randomId,
  readJsonFile,
  writeJsonFile
} from "@outpost/shared";

export type MothershipConfig = {
  beaconUrl: string;
  beacons?: MothershipBeaconConfig[];
  ai?: MothershipAiConfig;
  approvals?: MothershipApprovalConfig;
};

export type MothershipBeaconConfig = {
  url: string;
  label?: string;
};

export type MothershipAiConfig = {
  provider: "openai" | "openrouter";
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
  validationStatus: "missing_key" | "unvalidated" | "valid" | "invalid";
  lastValidatedAt?: string;
  lastValidationError?: string;
};

export type ApprovalMode = "automatic" | "confirm_risky" | "confirm_external_changes" | "manual";

export type MothershipApprovalConfig = {
  mode: ApprovalMode;
};

export type PairedOutpost = {
  peerId: string;
  publicKeyPem?: string;
  projectName?: string;
  hostLabel?: string;
  beaconUrl?: string;
  sourceRepo?: string;
  vpsHost?: string;
  projectPath?: string;
  lastStatus?: OutpostStatusReport;
  updatedAt: string;
};

export type MothershipState = {
  config: MothershipConfig;
  outposts: PairedOutpost[];
  publicKeyPem: string;
  privateKeyPem: string;
  peerId: string;
};

export function mothershipPaths(base = join(homedir(), ".outpost", "mothership")) {
  return {
    base,
    config: join(base, "config.json"),
    aiSecrets: join(base, "ai-secrets.json"),
    outposts: join(base, "outposts.json"),
    operations: join(base, "operations.json"),
    plugins: join(base, "plugins"),
    bootstrapOperations: join(base, "bootstrap-operations.json"),
    privateKey: join(base, "mothership_private.pem"),
    publicKey: join(base, "mothership_public.pem")
  };
}

export async function loadMothershipState(): Promise<MothershipState> {
  const paths = mothershipPaths();
  await ensureDir(paths.base);
  const keys = await ensureSigningKeyPair(paths.privateKey, paths.publicKey);
  if (!(await pathExists(paths.config))) {
    await writeJsonFile(paths.config, defaultMothershipConfig());
  }
  if (!(await pathExists(paths.outposts))) {
    await writeJsonFile(paths.outposts, []);
  }
  return {
    config: normalizeMothershipConfig(await readJsonFile<MothershipConfig>(paths.config)),
    outposts: await readJsonFile<PairedOutpost[]>(paths.outposts),
    publicKeyPem: keys.publicKeyPem,
    privateKeyPem: keys.privateKeyPem,
    peerId: peerIdFromPublicKey(keys.publicKeyPem)
  };
}

export async function saveMothershipConfig(config: MothershipConfig): Promise<MothershipConfig> {
  const normalized = normalizeMothershipConfig(config);
  await writeJsonFile(mothershipPaths().config, normalized);
  return normalized;
}

export async function createPairingCommand(
  input: {
    beaconUrl?: string;
    displayName?: string;
    buildHints?: PairingPayload["buildHints"];
  } = {}
): Promise<{ payload: PairingPayload; encoded: string; command: string }> {
  const state = await loadMothershipState();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 15 * 60_000);
  const payload: PairingPayload = {
    protocolVersion: PROTOCOL_VERSION,
    beaconUrl: input.beaconUrl ?? primaryBeaconUrl(state.config),
    mothershipPublicKey: state.publicKeyPem,
    mothershipPeerId: state.peerId,
    pairingNonce: randomId("pair"),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    displayName: input.displayName,
    buildHints: input.buildHints
  };
  const encoded = encodeJsonBase64(payload);
  return {
    payload,
    encoded,
    command: `npx @outpost/daemon setup --pair ${encoded}`
  };
}

export async function upsertOutpost(
  outpost: Omit<PairedOutpost, "updatedAt">
): Promise<PairedOutpost> {
  const paths = mothershipPaths();
  const existing = await readJsonFile<PairedOutpost[]>(paths.outposts);
  const next = { ...outpost, updatedAt: new Date().toISOString() };
  const index = existing.findIndex((item) => item.peerId === outpost.peerId);
  if (index === -1) {
    existing.push(next);
  } else {
    existing[index] = { ...existing[index], ...next };
  }
  await writeJsonFile(paths.outposts, existing);
  return next;
}

export function normalizeMothershipConfig(config: MothershipConfig): MothershipConfig {
  const fallback = config.beaconUrl || "ws://127.0.0.1:8787";
  const seen = new Set<string>();
  const beacons = (config.beacons?.length ? config.beacons : [{ url: fallback }])
    .map((beacon) => ({ url: beacon.url.trim(), label: beacon.label?.trim() || undefined }))
    .filter((beacon) => beacon.url.length > 0 && !seen.has(beacon.url) && seen.add(beacon.url));
  if (beacons.length === 0) {
    beacons.push({ url: "ws://127.0.0.1:8787", label: undefined });
  }
  return {
    beaconUrl: beacons[0].url,
    beacons,
    ai: normalizeAiConfig(config.ai),
    approvals: normalizeApprovalConfig(config.approvals)
  };
}

export function primaryBeaconUrl(config: MothershipConfig): string {
  return normalizeMothershipConfig(config).beacons?.[0]?.url ?? config.beaconUrl;
}

function defaultMothershipConfig(): MothershipConfig {
  return {
    beaconUrl: "ws://127.0.0.1:8787",
    beacons: [{ url: "ws://127.0.0.1:8787", label: "local" }],
    ai: defaultAiConfig(),
    approvals: { mode: "automatic" }
  };
}

export function defaultAiConfig(
  provider: MothershipAiConfig["provider"] = "openai"
): MothershipAiConfig {
  return {
    provider,
    baseUrl:
      provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
    defaultModel: provider === "openrouter" ? "openai/gpt-4.1-mini" : "gpt-4.1-mini",
    hasApiKey: false,
    validationStatus: "missing_key"
  };
}

export function normalizeAiConfig(
  config?: Partial<MothershipAiConfig> & {
    enabled?: boolean;
    model?: string;
  }
): MothershipAiConfig {
  const provider = config?.provider === "openrouter" ? "openrouter" : "openai";
  const defaults = defaultAiConfig(provider);
  const hasApiKey = Boolean(config?.hasApiKey);
  const defaultModel =
    typeof config?.defaultModel === "string" && config.defaultModel.trim()
      ? config.defaultModel.trim()
      : typeof config?.model === "string" && config.model.trim()
        ? config.model.trim()
        : defaults.defaultModel;
  const validationStatus = hasApiKey ? (config?.validationStatus ?? "unvalidated") : "missing_key";
  return {
    provider,
    baseUrl:
      typeof config?.baseUrl === "string" && config.baseUrl.trim()
        ? config.baseUrl.trim()
        : defaults.baseUrl,
    defaultModel,
    hasApiKey,
    validationStatus,
    lastValidatedAt: config?.lastValidatedAt,
    lastValidationError: validationStatus === "valid" ? undefined : config?.lastValidationError
  };
}

export function normalizeApprovalConfig(
  config?: Partial<MothershipApprovalConfig>
): MothershipApprovalConfig {
  const allowed: ApprovalMode[] = [
    "automatic",
    "confirm_risky",
    "confirm_external_changes",
    "manual"
  ];
  const mode = config?.mode;
  return {
    mode: mode && allowed.includes(mode) ? mode : "automatic"
  };
}
