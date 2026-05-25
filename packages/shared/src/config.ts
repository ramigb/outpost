/**
 * @module @outpost/shared/config
 *
 * Outpost configuration helpers: builder detection, package-manager inference,
 * config load/save, and filesystem path conventions.
 */

import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { OutpostState } from "@outpost/protocol";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, outpostDir } from "./fs.js";

/**
 * Detected or configured build-system settings.
 */
export type BuilderConfig = {
  /** Build system identifier. */
  builder: "vite" | "custom";
  /** Command to install dependencies, if any. */
  installCommand?: string;
  /** Command to produce a production build. */
  buildCommand?: string;
  /** Directory that contains build artifacts. */
  outputDir?: string;
};

/** Supported JavaScript package managers. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Full persisted Outpost configuration for a project.
 */
export type OutpostConfig = BuilderConfig & {
  /** Human-readable project name. */
  projectName: string;
  /** How many successful releases to keep on disk. */
  retainReleases: number;
  /** WebSocket URL of the Beacon relay. */
  beaconUrl?: string;
  /** Nonce used during the pairing handshake. */
  pairingNonce?: string;
  /** Optional host label for display. */
  hostLabel?: string;
  /** Command used to start a Node service in production. */
  startCommand?: string;
  /** TCP port the service listens on. */
  port?: number;
  /** URL to health-check after deployment. */
  healthUrl?: string;
  /** Optional systemd unit configuration. */
  systemd?: {
    serviceName?: string;
    user?: string;
    env?: Record<string, string>;
  };
};

/**
 * Persisted daemon state snapshot.
 */
export type OutpostPersistedState = {
  /** Current lifecycle state. */
  state: OutpostState;
  /** Active release ID, if any. */
  currentReleaseId?: string;
  /** Active branch, if any. */
  currentBranch?: string;
  /** Active commit, if any. */
  currentCommit?: string;
  /** Last recorded error message. */
  lastError?: string;
  /** ISO-8601 timestamp of the last update. */
  updatedAt: string;
};

/**
 * Default Vite builder configuration used as a fallback.
 */
export const defaultViteBuilder: BuilderConfig = {
  builder: "vite",
  installCommand: "npm install",
  buildCommand: "npm run build",
  outputDir: "dist"
};

/**
 * Detects which package manager a project uses by looking for lockfiles.
 *
 * @param projectRoot - Directory to inspect. Defaults to `process.cwd()`.
 * @returns Detected package manager, falling back to `"npm"`.
 */
export async function detectPackageManager(projectRoot = process.cwd()): Promise<PackageManager> {
  if (await pathExists(join(projectRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(join(projectRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (
    (await pathExists(join(projectRoot, "bun.lock"))) ||
    (await pathExists(join(projectRoot, "bun.lockb")))
  ) {
    return "bun";
  }
  return "npm";
}

/**
 * Returns the conventional install and build commands for a package manager.
 *
 * @param packageManager - Package manager identifier.
 * @returns Install and build command strings.
 */
export function commandsForPackageManager(
  packageManager: PackageManager
): Pick<BuilderConfig, "installCommand" | "buildCommand"> {
  switch (packageManager) {
    case "pnpm":
      return { installCommand: "pnpm install", buildCommand: "pnpm build" };
    case "yarn":
      return { installCommand: "yarn install", buildCommand: "yarn build" };
    case "bun":
      return { installCommand: "bun install", buildCommand: "bun run build" };
    case "npm":
      return { installCommand: "npm install", buildCommand: "npm run build" };
  }
}

/**
 * Returns all conventional `.outpost/` paths for a given project root.
 *
 * @param projectRoot - Directory of the managed project.
 * @returns Absolute paths for config, state, logs, releases, live symlink, and keys.
 */
export function outpostPaths(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const base = outpostDir(root);
  return {
    projectRoot: root,
    base,
    config: join(base, "config.json"),
    state: join(base, "state.json"),
    logs: join(base, "logs"),
    daemonLog: join(base, "logs", "daemon.log"),
    buildsLog: join(base, "logs", "builds.log"),
    releases: join(base, "releases"),
    live: join(base, "live"),
    mothershipPublicKey: join(base, "mothership_pub.pem"),
    outpostPrivateKey: join(base, "outpost_private.pem"),
    outpostPublicKey: join(base, "outpost_public.pem")
  };
}

/**
 * Detects whether the project uses a supported builder.
 *
 * @param projectRoot - Directory to inspect.
 * @returns Builder configuration, or `null` when no supported builder is found.
 */
export async function detectBuilder(projectRoot = process.cwd()): Promise<BuilderConfig | null> {
  const packageJsonPath = join(projectRoot, "package.json");
  if (await pathExists(packageJsonPath)) {
    const packageJson = await readJsonFile<Record<string, unknown>>(packageJsonPath);
    const deps = {
      ...asRecord(packageJson.dependencies),
      ...asRecord(packageJson.devDependencies)
    };
    if (typeof deps.vite === "string") {
      return {
        ...defaultViteBuilder,
        ...commandsForPackageManager(await detectPackageManager(projectRoot))
      };
    }
  }
  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"]) {
    if (await pathExists(join(projectRoot, name))) {
      return {
        ...defaultViteBuilder,
        ...commandsForPackageManager(await detectPackageManager(projectRoot))
      };
    }
  }
  return null;
}

/**
 * Creates a default Outpost configuration by auto-detecting the builder.
 *
 * @param projectRoot - Directory of the managed project.
 * @returns A fully-populated configuration object.
 * @throws Error when no supported builder is detected.
 */
export async function createDefaultOutpostConfig(
  projectRoot = process.cwd()
): Promise<OutpostConfig> {
  const detected = await detectBuilder(projectRoot);
  if (!detected) {
    throw new Error(
      "No Vite project detected. Add .outpost/config.json with a custom builder before initializing."
    );
  }
  return {
    projectName: basename(resolve(projectRoot)),
    hostLabel: hostname(),
    retainReleases: 5,
    ...detected
  };
}

/**
 * Loads the persisted Outpost configuration from disk.
 *
 * @param projectRoot - Directory of the managed project.
 * @returns Parsed {@link OutpostConfig}.
 * @throws Error when the file is missing or unreadable.
 */
export async function loadOutpostConfig(projectRoot = process.cwd()): Promise<OutpostConfig> {
  return readJsonFile<OutpostConfig>(outpostPaths(projectRoot).config);
}

/**
 * Saves an Outpost configuration to disk.
 *
 * @param projectRoot - Directory of the managed project.
 * @param config - Configuration to persist.
 */
export async function saveOutpostConfig(projectRoot: string, config: OutpostConfig): Promise<void> {
  await writeJsonFile(outpostPaths(projectRoot).config, config);
}

/**
 * Saves the Outpost daemon state to disk, automatically adding an `updatedAt` timestamp.
 *
 * @param projectRoot - Directory of the managed project.
 * @param state - State fields to persist (excluding `updatedAt`).
 * @returns The fully persisted state with timestamp.
 */
export async function saveOutpostState(
  projectRoot: string,
  state: Omit<OutpostPersistedState, "updatedAt">
): Promise<OutpostPersistedState> {
  const persisted = { ...state, updatedAt: new Date().toISOString() };
  await writeJsonFile(outpostPaths(projectRoot).state, persisted);
  return persisted;
}

/**
 * Creates the `.outpost/` directory structure if it does not yet exist.
 *
 * @param projectRoot - Directory of the managed project.
 */
export async function initializeOutpostDirectories(projectRoot = process.cwd()): Promise<void> {
  const paths = outpostPaths(projectRoot);
  await ensureDir(paths.base);
  await ensureDir(paths.logs);
  await ensureDir(paths.releases);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
