import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  detectBuilder,
  detectPackageManager,
  pathExists,
  recommendDeploymentRecipes
} from "@outpost/shared";

export type DetectedApp = {
  projectPath: string;
  appTypes: string[];
  packageManager?: string;
  scripts: string[];
  dependencies: string[];
  outputDir?: string;
  buildCommand?: string;
  recipeIds: string[];
  hasDockerfile: boolean;
  hasComposeFile: boolean;
  warnings: string[];
};

export type HealthCheckResult = {
  url?: string;
  ok: boolean;
  status?: number;
  statusText?: string;
  durationMs: number;
  message: string;
};

export async function detectApp(projectRoot: string, projectPath?: string): Promise<DetectedApp> {
  const targetPath = resolveProjectPath(projectRoot, projectPath);
  const warnings: string[] = [];
  const scripts: string[] = [];
  const dependencies: string[] = [];
  const appTypes = new Set<string>();

  const packageJsonPath = resolve(targetPath, "package.json");
  let packageJson: Record<string, unknown> | undefined;
  if (await pathExists(packageJsonPath)) {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
    for (const name of Object.keys(asRecord(packageJson.scripts))) {
      scripts.push(name);
    }
    const deps = {
      ...asRecord(packageJson.dependencies),
      ...asRecord(packageJson.devDependencies)
    };
    dependencies.push(...Object.keys(deps).sort());
    if (typeof deps.vite === "string") {
      appTypes.add("vite_static");
    }
    if (typeof deps.next === "string") {
      appTypes.add("nextjs");
    }
    if (
      typeof deps.express === "string" ||
      typeof deps.fastify === "string" ||
      typeof deps["@hono/node-server"] === "string"
    ) {
      appTypes.add("node_server");
    }
  } else {
    warnings.push("package.json was not found");
  }

  if (
    await hasAny(targetPath, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
      "vite.config.mjs"
    ])
  ) {
    appTypes.add("vite_static");
  }
  const hasDockerfile = await pathExists(resolve(targetPath, "Dockerfile"));
  if (hasDockerfile) {
    appTypes.add("docker");
  }
  const hasComposeFile = await hasAny(targetPath, [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml"
  ]);
  if (hasComposeFile) {
    appTypes.add("compose");
  }

  const builder = await detectBuilder(targetPath).catch(() => null);
  if (appTypes.size === 0) {
    warnings.push("No supported app type was detected");
  }

  return {
    projectPath: targetPath,
    appTypes: [...appTypes].sort(),
    packageManager: packageJson ? await detectPackageManager(targetPath) : undefined,
    scripts: scripts.sort(),
    dependencies,
    outputDir: builder?.outputDir,
    buildCommand: builder?.buildCommand,
    recipeIds: recommendDeploymentRecipes([...appTypes]).map((recipe) => recipe.id),
    hasDockerfile,
    hasComposeFile,
    warnings
  };
}

export async function runHealthCheck(url?: string): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  if (!url) {
    return {
      ok: false,
      durationMs: 0,
      message: "No health check URL was provided"
    };
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Health check URL must use http or https");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(parsed, { method: "GET", signal: controller.signal });
    const durationMs = Date.now() - startedAt;
    return {
      url: parsed.toString(),
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      durationMs,
      message: response.ok
        ? `HTTP ${response.status}`
        : `Health check failed with HTTP ${response.status}`
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Health check timed out"
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      url: parsed.toString(),
      ok: false,
      durationMs,
      message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveProjectPath(projectRoot: string, projectPath?: string): string {
  if (projectPath && projectPath.startsWith("/")) {
    throw new Error("projectPath must be relative to the Outpost project root");
  }
  const root = resolve(projectRoot);
  const target = resolve(root, projectPath ?? ".");
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("projectPath must stay within the Outpost project root");
  }
  return target;
}

async function hasAny(projectRoot: string, filenames: string[]): Promise<boolean> {
  for (const filename of filenames) {
    if (await pathExists(resolve(projectRoot, filename))) {
      return true;
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
