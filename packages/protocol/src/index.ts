export const PROTOCOL_VERSION = "outpost.v1";

export type PeerRole = "mothership" | "outpost";

export type OutpostState =
  | "UNINITIALIZED"
  | "UNPAIRED"
  | "PAIRING"
  | "PAIRED_ONLINE"
  | "PAIRED_OFFLINE"
  | "DEPLOYING"
  | "ROLLING_BACK"
  | "ERROR";

export type OutpostCommand =
  | { type: "PING" }
  | { type: "DEPLOY"; appId?: string; ref?: string; branch?: string; commit?: string }
  | { type: "ROLLBACK"; appId?: string; releaseId: string }
  | { type: "SET_ENV"; appId?: string; encryptedEnv: string }
  | { type: "DETECT_APP"; projectPath?: string }
  | { type: "RUN_HEALTH_CHECK"; appId?: string; url?: string }
  | {
      type: "APPLY_RECIPE";
      appId?: string;
      recipeId: string;
      approvedParameters: Record<string, unknown>;
    }
  | { type: "DOCTOR" }
  | { type: "GET_STATE" };

export type ReleaseMetadata = {
  releaseId: string;
  createdAt: string;
  branch?: string;
  commit: string;
  status: "success" | "failed";
  buildCommand: string;
  outputDir: string;
  durationMs: number;
};

export type OutpostStatusReport = {
  state: OutpostState;
  projectName: string;
  hostLabel?: string;
  currentReleaseId?: string;
  currentBranch?: string;
  currentCommit?: string;
  releases: ReleaseMetadata[];
  lastError?: string;
};

export type BuildLogEvent = {
  deploymentId: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
  createdAt: string;
};

export type CommandResult = {
  commandType: OutpostCommand["type"];
  ok: boolean;
  message?: string;
  releaseId?: string;
  exitCode?: number;
  data?: unknown;
};

export type PairingPayload = {
  protocolVersion: typeof PROTOCOL_VERSION;
  beaconUrl: string;
  mothershipPublicKey: string;
  mothershipPeerId: string;
  pairingNonce: string;
  createdAt: string;
  expiresAt: string;
  displayName?: string;
  buildHints?: {
    installCommand?: string;
    buildCommand?: string;
    outputDir?: string;
    projectName?: string;
    retainReleases?: number;
  };
};

export type PairingHello = {
  type: "PAIRING_HELLO";
  protocolVersion: typeof PROTOCOL_VERSION;
  pairingNonce: string;
  outpostPublicKey: string;
  projectName: string;
  hostLabel?: string;
};

export type SignedEnvelope<TPayload = unknown> = {
  protocolVersion: typeof PROTOCOL_VERSION;
  messageId: string;
  senderId: string;
  recipientId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payload: TPayload;
  signature: string;
};

export type EncryptedPayload = {
  keyId: string;
  ephemeralPublicKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type RelayRegisterMessage = {
  type: "REGISTER";
  role: PeerRole;
  peerId: string;
  pairingNonce?: string;
};

export type RelayForwardMessage = {
  type: "FORWARD";
  from: string;
  to: string;
  body: unknown;
};

export type RelayServerMessage =
  | { type: "REGISTERED"; peerId: string }
  | { type: "PEER_ONLINE"; peerId: string }
  | { type: "PEER_OFFLINE"; peerId: string }
  | { type: "FORWARD"; from: string; body: unknown }
  | { type: "ERROR"; message: string };

export type RelayClientMessage = RelayRegisterMessage | RelayForwardMessage;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string`);
  }
  return value;
}

export function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string when provided`);
  }
  return value;
}

export function asOptionalRecord(
  value: unknown,
  field: string
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Expected ${field} to be an object when provided`);
  }
  return value;
}

export function parsePairingPayload(value: unknown): PairingPayload {
  if (!isRecord(value)) {
    throw new Error("Pairing payload must be an object");
  }
  const protocolVersion = asString(value.protocolVersion, "protocolVersion");
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${protocolVersion}`);
  }
  return {
    protocolVersion,
    beaconUrl: asString(value.beaconUrl, "beaconUrl"),
    mothershipPublicKey: asString(value.mothershipPublicKey, "mothershipPublicKey"),
    mothershipPeerId: asString(value.mothershipPeerId, "mothershipPeerId"),
    pairingNonce: asString(value.pairingNonce, "pairingNonce"),
    createdAt: asString(value.createdAt, "createdAt"),
    expiresAt: asString(value.expiresAt, "expiresAt"),
    displayName: asOptionalString(value.displayName, "displayName"),
    buildHints: parseBuildHints(value.buildHints)
  };
}

function parseBuildHints(value: unknown): PairingPayload["buildHints"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Expected buildHints to be an object when provided");
  }
  const retainReleases = value.retainReleases;
  if (retainReleases !== undefined && typeof retainReleases !== "number") {
    throw new Error("Expected buildHints.retainReleases to be a number when provided");
  }
  return {
    installCommand: asOptionalString(value.installCommand, "buildHints.installCommand"),
    buildCommand: asOptionalString(value.buildCommand, "buildHints.buildCommand"),
    outputDir: asOptionalString(value.outputDir, "buildHints.outputDir"),
    projectName: asOptionalString(value.projectName, "buildHints.projectName"),
    retainReleases
  };
}

export function parseOutpostCommand(value: unknown): OutpostCommand {
  if (!isRecord(value)) {
    throw new Error("Command must be an object");
  }
  const type = asString(value.type, "type");
  switch (type) {
    case "PING":
    case "DOCTOR":
    case "GET_STATE":
      return { type };
    case "DEPLOY":
      return {
        type,
        appId: asOptionalString(value.appId, "appId"),
        ref: asOptionalString(value.ref, "ref"),
        branch: asOptionalString(value.branch, "branch"),
        commit: asOptionalString(value.commit, "commit")
      };
    case "ROLLBACK":
      return {
        type,
        appId: asOptionalString(value.appId, "appId"),
        releaseId: asString(value.releaseId, "releaseId")
      };
    case "SET_ENV":
      return {
        type,
        appId: asOptionalString(value.appId, "appId"),
        encryptedEnv: asString(value.encryptedEnv, "encryptedEnv")
      };
    case "DETECT_APP":
      return { type, projectPath: asOptionalString(value.projectPath, "projectPath") };
    case "RUN_HEALTH_CHECK":
      return {
        type,
        appId: asOptionalString(value.appId, "appId"),
        url: asOptionalString(value.url, "url")
      };
    case "APPLY_RECIPE":
      return {
        type,
        appId: asOptionalString(value.appId, "appId"),
        recipeId: asString(value.recipeId, "recipeId"),
        approvedParameters: asOptionalRecord(value.approvedParameters, "approvedParameters") ?? {}
      };
    default:
      throw new Error(`Unsupported command type: ${type}`);
  }
}

export function parseRelayClientMessage(value: unknown): RelayClientMessage {
  if (!isRecord(value)) {
    throw new Error("Relay message must be an object");
  }
  const type = asString(value.type, "type");
  if (type === "REGISTER") {
    const role = asString(value.role, "role");
    if (role !== "mothership" && role !== "outpost") {
      throw new Error(`Invalid role: ${role}`);
    }
    return {
      type,
      role,
      peerId: asString(value.peerId, "peerId"),
      pairingNonce: asOptionalString(value.pairingNonce, "pairingNonce")
    };
  }
  if (type === "FORWARD") {
    return {
      type,
      from: asString(value.from, "from"),
      to: asString(value.to, "to"),
      body: value.body
    };
  }
  throw new Error(`Unsupported relay message type: ${type}`);
}

export function encodeJsonBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeJsonBase64(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}
