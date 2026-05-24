import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { OutpostState } from "@outpost/protocol";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, outpostDir } from "./fs.js";

export type BuilderConfig = {
  builder: "vite" | "custom";
  installCommand?: string;
  buildCommand?: string;
  outputDir?: string;
};

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type OutpostConfig = BuilderConfig & {
  projectName: string;
  retainReleases: number;
  beaconUrl?: string;
  pairingNonce?: string;
  hostLabel?: string;
  startCommand?: string;
  port?: number;
  healthUrl?: string;
  systemd?: {
    serviceName?: string;
    user?: string;
    env?: Record<string, string>;
  };
};

export type OutpostPersistedState = {
  state: OutpostState;
  currentReleaseId?: string;
  currentBranch?: string;
  currentCommit?: string;
  lastError?: string;
  updatedAt: string;
};

export const defaultViteBuilder: BuilderConfig = {
  builder: "vite",
  installCommand: "npm install",
  buildCommand: "npm run build",
  outputDir: "dist"
};

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

export async function loadOutpostConfig(projectRoot = process.cwd()): Promise<OutpostConfig> {
  return readJsonFile<OutpostConfig>(outpostPaths(projectRoot).config);
}

export async function saveOutpostConfig(projectRoot: string, config: OutpostConfig): Promise<void> {
  await writeJsonFile(outpostPaths(projectRoot).config, config);
}

export async function saveOutpostState(
  projectRoot: string,
  state: Omit<OutpostPersistedState, "updatedAt">
): Promise<OutpostPersistedState> {
  const persisted = { ...state, updatedAt: new Date().toISOString() };
  await writeJsonFile(outpostPaths(projectRoot).state, persisted);
  return persisted;
}

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
