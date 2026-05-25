/**
 * @module @outpost/mothership/provisioning
 *
 * Local and remote host inspection, app detection, health checking, and
 * deployment readiness planning.
 *
 * These are the concrete implementations behind the `host.inspect_local`,
 * `host.inspect_ssh`, `app.detect_local`, `health.http_check`, and
 * `provisioning.plan_local` tools.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathExists, recommendDeploymentRecipes, type DeploymentRecipe } from "@outpost/shared";
import type { ToolRunContext } from "./tools.js";

/**
 * Result of inspecting a host (local or remote over SSH).
 */
export type HostInspection = {
  target: string;
  inspectedAt: string;
  os?: {
    platform?: string;
    release?: string;
    architecture?: string;
    prettyName?: string;
  };
  memory?: {
    totalBytes?: number;
    availableBytes?: number;
    totalHuman?: string;
    availableHuman?: string;
  };
  packageManager?: "apt" | "dnf" | "yum" | "apk" | "pacman" | "unknown";
  runtimes: Record<string, ToolAvailability>;
  serviceManagers: Record<string, ToolAvailability>;
  webServers: Record<string, ToolAvailability>;
  listeningPorts?: string[];
  warnings: string[];
};

/** Availability info for a command-line tool. */
export type ToolAvailability = {
  available: boolean;
  path?: string;
  version?: string;
};

/**
 * Result of detecting app type signals in a local project.
 */
export type AppDetection = {
  projectPath: string;
  inspectedAt: string;
  appTypes: string[];
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  scripts: string[];
  outputDir?: string;
  recipeIds: string[];
  dockerCompose: boolean;
  dockerfile: boolean;
  warnings: string[];
};

/**
 * Result of an HTTP health check.
 */
export type HttpHealthCheck = {
  url: string;
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
};

/**
 * Combined readiness plan produced from host and app inspection.
 */
export type ProvisioningPlan = {
  target: string;
  projectPath: string;
  authorityMode: "local_host";
  appTypes: string[];
  ready: boolean;
  missingCapabilities: string[];
  recommendedTools: string[];
  recipes: DeploymentRecipe[];
  planSteps: string[];
  warnings: string[];
  host: HostInspection;
  app: AppDetection;
};

/**
 * Inspects the local machine for OS, runtimes, services, and ports.
 *
 * @param context - Optional tool run context for emitting progress events.
 * @returns Host inspection result.
 */
export async function inspectLocalHost(context?: ToolRunContext): Promise<HostInspection> {
  await context?.emit({
    level: "info",
    phase: "inspect",
    message: "Detecting local operating system",
    toolName: "host.inspect_local",
    target: "local"
  });
  const [uname, osRelease] = await Promise.all([runCommand("uname", ["-srm"]), readOsRelease()]);
  const inspection: HostInspection = {
    target: "local",
    inspectedAt: new Date().toISOString(),
    os: {
      platform: process.platform,
      release: uname.ok ? uname.stdout.trim() : undefined,
      architecture: process.arch,
      prettyName: osRelease.PRETTY_NAME
    },
    memory: await readMemoryInfo(),
    packageManager: await detectPackageManager(),
    runtimes: {},
    serviceManagers: {},
    webServers: {},
    warnings: []
  };

  await context?.emit({
    level: "info",
    phase: "inspect",
    message: "Checking runtime availability",
    toolName: "host.inspect_local",
    target: "local"
  });
  inspection.runtimes = {
    node: await commandAvailability("node", ["--version"]),
    npm: await commandAvailability("npm", ["--version"]),
    git: await commandAvailability("git", ["--version"]),
    docker: await commandAvailability("docker", ["--version"]),
    ssh: await commandAvailability("ssh", ["-V"]),
    curl: await commandAvailability("curl", ["--version"]),
    free: await commandAvailability("free", ["--version"])
  };
  inspection.serviceManagers = {
    systemctl: await commandAvailability("systemctl", ["--version"])
  };
  inspection.webServers = {
    caddy: await commandAvailability("caddy", ["version"]),
    nginx: await commandAvailability("nginx", ["-v"])
  };

  await context?.emit({
    level: "info",
    phase: "inspect",
    message: "Checking listening ports",
    toolName: "host.inspect_local",
    target: "local"
  });
  inspection.listeningPorts = await readListeningPorts();
  addHostWarnings(inspection);
  return inspection;
}

/**
 * Inspects a remote host over SSH using read-only shell probes.
 *
 * @param sshTarget - SSH destination (`user@host` or `host`).
 * @param context - Optional tool run context.
 * @returns Parsed host inspection result.
 * @throws Error when the SSH connection or probe script fails.
 */
export async function inspectSshHost(
  sshTarget: string,
  context?: ToolRunContext
): Promise<HostInspection> {
  const target = assertSshTarget(sshTarget);
  await context?.emit({
    level: "info",
    phase: "ssh",
    message: `Connecting to ${target}`,
    toolName: "host.inspect_ssh",
    target
  });
  const script = [
    "set -u",
    "echo __OUTPOST_OS__",
    "uname -srm || true",
    "cat /etc/os-release 2>/dev/null || true",
    "echo __OUTPOST_MEMORY__",
    'awk \'/^MemTotal:/{print "MemTotalKiB=" $2} /^MemAvailable:/{print "MemAvailableKiB=" $2}\' /proc/meminfo 2>/dev/null || true',
    'free -k 2>/dev/null | awk \'/^Mem:/ { if ($2) print "MemTotalKiB=" $2; if ($7) print "MemAvailableKiB=" $7; }\' || true',
    "echo __OUTPOST_COMMANDS__",
    'for c in apt dnf yum apk pacman node npm git docker systemctl caddy nginx ss ssh curl free; do printf \'%s=\' "$c"; command -v "$c" || true; done',
    "echo __OUTPOST_VERSIONS__",
    "node --version 2>/dev/null || true",
    "npm --version 2>/dev/null || true",
    "git --version 2>/dev/null || true",
    "docker --version 2>/dev/null || true",
    "caddy version 2>/dev/null || true",
    "nginx -v 2>&1 || true",
    "echo __OUTPOST_PORTS__",
    "ss -tulpn 2>/dev/null | head -n 40 || true"
  ].join("\n");
  const result = await runCommand("ssh", [target, script], 15_000);
  if (!result.ok) {
    throw new Error(
      result.stderr || result.stdout || `SSH inspection failed with exit code ${result.exitCode}`
    );
  }
  await context?.emit({
    level: "success",
    phase: "ssh",
    message: `Collected host information from ${target}`,
    toolName: "host.inspect_ssh",
    target
  });
  return parseSshInspection(target, result.stdout);
}

/**
 * Runs an arbitrary shell command on a remote host over SSH.
 *
 * @param sshTarget - SSH destination.
 * @param command - Shell command to execute.
 * @param context - Optional tool run context.
 * @returns stdout, stderr, and exit code.
 */
export async function runSshCommand(
  sshTarget: string,
  command: string,
  context?: ToolRunContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const target = assertSshTarget(sshTarget);
  await context?.emit({
    level: "info",
    phase: "ssh",
    message: `Executing on ${target}: ${command}`,
    toolName: "host.run_ssh_command",
    target
  });
  const result = await runCommand("ssh", [target, command], 30_000);
  await context?.emit({
    level: result.ok ? "success" : "error",
    phase: "ssh",
    message: result.ok
      ? `Command completed on ${target}`
      : `Command failed with code ${result.exitCode}`,
    toolName: "host.run_ssh_command",
    target
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}

/**
 * Detects app type signals in a local project directory.
 *
 * @param projectPath - Path to inspect.
 * @param context - Optional tool run context.
 * @returns App detection result.
 */
export async function detectLocalApp(
  projectPath: string,
  context?: ToolRunContext
): Promise<AppDetection> {
  const root = resolve(projectPath || ".");
  await context?.emit({
    level: "info",
    phase: "detect",
    message: `Inspecting app at ${root}`,
    toolName: "app.detect_local",
    target: root
  });
  const detection: AppDetection = {
    projectPath: root,
    inspectedAt: new Date().toISOString(),
    appTypes: [],
    scripts: [],
    recipeIds: [],
    dockerCompose:
      (await pathExists(join(root, "docker-compose.yml"))) ||
      (await pathExists(join(root, "compose.yml"))),
    dockerfile: await pathExists(join(root, "Dockerfile")),
    warnings: []
  };
  const packageJsonPath = join(root, "package.json");
  if (await pathExists(packageJsonPath)) {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    const deps = {
      ...asRecord(packageJson.dependencies),
      ...asRecord(packageJson.devDependencies)
    };
    const scripts = asRecord(packageJson.scripts);
    detection.scripts = Object.keys(scripts);
    detection.packageManager = await detectProjectPackageManager(root);
    if (typeof deps.vite === "string") {
      detection.appTypes.push("vite", "static_frontend");
      detection.outputDir = "dist";
    }
    if (typeof deps.next === "string") {
      detection.appTypes.push("server_rendered_javascript");
    }
    if (typeof deps.express === "string" || typeof scripts.start === "string") {
      detection.appTypes.push("node_service");
    }
  }
  if (detection.dockerfile || detection.dockerCompose) {
    detection.appTypes.push(detection.dockerCompose ? "docker_compose" : "docker");
  }
  if (detection.appTypes.length === 0) {
    detection.warnings.push("No known app recipe signals were detected.");
  }
  detection.recipeIds = recommendDeploymentRecipes(detection.appTypes).map((recipe) => recipe.id);
  return detection;
}

/**
 * Runs an HTTP GET request against a URL with an optional timeout.
 *
 * @param url - URL to check.
 * @param timeoutMs - Request timeout. Defaults to 5000 ms.
 * @param context - Optional tool run context.
 * @returns Health check result.
 */
export async function runHttpHealthCheck(
  url: string,
  timeoutMs = 5_000,
  context?: ToolRunContext
): Promise<HttpHealthCheck> {
  const started = Date.now();
  await context?.emit({
    level: "info",
    phase: "health",
    message: `Checking ${url}`,
    toolName: "health.http_check",
    target: url
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      url,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - started
    };
  } catch (error) {
    return {
      url,
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Creates a deployment readiness plan from local host and app inspection.
 *
 * @param projectPath - Project to plan for.
 * @param context - Optional tool run context.
 * @returns Combined plan with missing capabilities and recommended steps.
 */
export async function createLocalProvisioningPlan(
  projectPath: string,
  context?: ToolRunContext
): Promise<ProvisioningPlan> {
  await context?.emit({
    level: "info",
    phase: "plan",
    message: "Inspecting local host for deployment readiness",
    toolName: "provisioning.plan_local",
    target: "local"
  });
  const host = await inspectLocalHost(context);
  await context?.emit({
    level: "info",
    phase: "plan",
    message: "Detecting local app recipe signals",
    toolName: "provisioning.plan_local",
    target: projectPath || "."
  });
  const app = await detectLocalApp(projectPath || ".", context);
  const missingCapabilities = missingCapabilitiesFor(host, app);
  const recommendedTools = recommendedToolsFor(host, app);
  const recipes = recommendDeploymentRecipes(app.appTypes);
  const planSteps = planStepsFor(host, app, missingCapabilities, recipes);
  const warnings = [...host.warnings, ...app.warnings];
  return {
    target: "local",
    projectPath: app.projectPath,
    authorityMode: "local_host",
    appTypes: app.appTypes,
    ready: missingCapabilities.length === 0 && app.appTypes.length > 0,
    missingCapabilities,
    recommendedTools,
    recipes,
    planSteps,
    warnings,
    host,
    app
  };
}

async function commandAvailability(
  command: string,
  versionArgs: string[]
): Promise<ToolAvailability> {
  const path = await runCommand("which", [command]);
  if (!path.ok || !path.stdout.trim()) {
    return { available: false };
  }
  const version = await runCommand(command, versionArgs);
  return {
    available: true,
    path: path.stdout.trim(),
    version: (version.stdout || version.stderr).trim().split(/\r?\n/)[0]
  };
}

async function detectPackageManager(): Promise<HostInspection["packageManager"]> {
  for (const manager of ["apt", "dnf", "yum", "apk", "pacman"] as const) {
    const result = await runCommand("which", [manager]);
    if (result.ok && result.stdout.trim()) {
      return manager;
    }
  }
  return "unknown";
}

async function detectProjectPackageManager(root: string): Promise<AppDetection["packageManager"]> {
  if (await pathExists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(join(root, "yarn.lock"))) return "yarn";
  if ((await pathExists(join(root, "bun.lock"))) || (await pathExists(join(root, "bun.lockb"))))
    return "bun";
  return "npm";
}

async function readListeningPorts(): Promise<string[]> {
  const ss = await runCommand("ss", ["-tulpn"]);
  if (ss.ok && ss.stdout.trim()) {
    return ss.stdout.trim().split(/\r?\n/).slice(0, 40);
  }
  const lsof = await runCommand("lsof", ["-i", "-P", "-n"]);
  return lsof.ok ? lsof.stdout.trim().split(/\r?\n/).slice(0, 40) : [];
}

async function readOsRelease(): Promise<Record<string, string>> {
  if (!(await pathExists("/etc/os-release"))) {
    return {};
  }
  const content = await readFile("/etc/os-release", "utf8");
  return parseKeyValueLines(content);
}

async function readMemoryInfo(): Promise<HostInspection["memory"]> {
  if (!(await pathExists("/proc/meminfo"))) {
    return {};
  }
  const lines = (await readFile("/proc/meminfo", "utf8")).split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)/);
    return match ? [`${match[1]}KiB=${match[2]}`] : [];
  });
  return parseMemoryInfo(lines);
}

function parseMemoryInfo(lines: string[]): HostInspection["memory"] {
  const values: Record<string, number> = {};
  for (const line of lines) {
    const [key, rawValue] = line.split("=");
    const value = Number(rawValue);
    if (key && Number.isFinite(value)) {
      values[key] = value * 1024;
    }
  }
  const totalBytes = values.MemTotalKiB;
  const availableBytes = values.MemAvailableKiB;
  return {
    totalBytes,
    availableBytes,
    totalHuman: totalBytes ? formatBytes(totalBytes) : undefined,
    availableHuman: availableBytes ? formatBytes(availableBytes) : undefined
  };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parseSshInspection(target: string, stdout: string): HostInspection {
  const sections = splitSections(stdout);
  const osLines = sections.__OUTPOST_OS__ ?? [];
  const commandMap = parseCommandMap(sections.__OUTPOST_COMMANDS__ ?? []);
  const versionLines = sections.__OUTPOST_VERSIONS__ ?? [];
  const osRelease = parseKeyValueLines(osLines.slice(1).join("\n"));
  const inspection: HostInspection = {
    target,
    inspectedAt: new Date().toISOString(),
    os: {
      release: osLines[0],
      prettyName: osRelease.PRETTY_NAME
    },
    memory: parseMemoryInfo(sections.__OUTPOST_MEMORY__ ?? []),
    packageManager:
      (firstAvailable(commandMap, [
        "apt",
        "dnf",
        "yum",
        "apk",
        "pacman"
      ]) as HostInspection["packageManager"]) ?? "unknown",
    runtimes: {
      node: availabilityFromMap(commandMap, "node", versionLines[0]),
      npm: availabilityFromMap(commandMap, "npm", versionLines[1]),
      git: availabilityFromMap(commandMap, "git", versionLines[2]),
      docker: availabilityFromMap(commandMap, "docker", versionLines[3]),
      ssh: availabilityFromMap(commandMap, "ssh"),
      curl: availabilityFromMap(commandMap, "curl"),
      free: availabilityFromMap(commandMap, "free")
    },
    serviceManagers: {
      systemctl: availabilityFromMap(commandMap, "systemctl")
    },
    webServers: {
      caddy: availabilityFromMap(commandMap, "caddy", versionLines[4]),
      nginx: availabilityFromMap(commandMap, "nginx", versionLines[5])
    },
    listeningPorts: sections.__OUTPOST_PORTS__ ?? [],
    warnings: []
  };
  addHostWarnings(inspection);
  return inspection;
}

function addHostWarnings(inspection: HostInspection): void {
  if (!inspection.runtimes.git?.available) {
    inspection.warnings.push("Git is not available.");
  }
  if (!inspection.runtimes.node?.available) {
    inspection.warnings.push("Node.js is not available.");
  }
  if (!inspection.webServers.caddy?.available && !inspection.webServers.nginx?.available) {
    inspection.warnings.push("Neither Caddy nor nginx was detected.");
  }
}

function missingCapabilitiesFor(host: HostInspection, app: AppDetection): string[] {
  const missing = new Set<string>();
  if (!host.runtimes.git?.available) {
    missing.add("git");
  }
  if (
    app.appTypes.some((type) =>
      [
        "vite",
        "static_frontend",
        "node_service",
        "node_server",
        "server_rendered_javascript",
        "nextjs"
      ].includes(type)
    )
  ) {
    if (!host.runtimes.node?.available) {
      missing.add("node");
    }
    if (app.packageManager && !host.runtimes[app.packageManager]?.available) {
      missing.add(app.packageManager);
    }
  }
  if (
    app.appTypes.some((type) => ["docker", "docker_compose"].includes(type)) &&
    !host.runtimes.docker?.available
  ) {
    missing.add("docker");
  }
  if (
    !host.webServers.caddy?.available &&
    !host.webServers.nginx?.available &&
    !app.appTypes.includes("docker_compose")
  ) {
    missing.add("web_server");
  }
  if (app.appTypes.length === 0) {
    missing.add("deployment_recipe");
  }
  return [...missing];
}

function recommendedToolsFor(host: HostInspection, app: AppDetection): string[] {
  const tools = ["host.inspect_local", "app.detect_local"];
  if (app.appTypes.includes("vite") || app.appTypes.includes("static_frontend")) {
    tools.push("mothership.bootstrap_vps", "outpost.deploy", "health.http_check");
  }
  if (
    app.appTypes.includes("node_service") ||
    app.appTypes.includes("node_server") ||
    app.appTypes.includes("server_rendered_javascript") ||
    app.appTypes.includes("nextjs")
  ) {
    tools.push("service.setup_systemd", "web.configure_reverse_proxy", "health.http_check");
  }
  if (app.appTypes.includes("docker") || app.appTypes.includes("docker_compose")) {
    tools.push("docker.build_or_pull", "docker.rollout", "health.http_check");
  }
  if (!host.webServers.caddy?.available && !host.webServers.nginx?.available) {
    tools.push("web.install_or_configure");
  }
  return [...new Set(tools)];
}

function planStepsFor(
  host: HostInspection,
  app: AppDetection,
  missingCapabilities: string[],
  recipes: DeploymentRecipe[]
): string[] {
  const steps = [
    "Confirm deployment target, domain, and desired authority mode.",
    "Inspect host and app signals."
  ];
  if (missingCapabilities.length > 0) {
    steps.push(`Resolve missing capabilities: ${missingCapabilities.join(", ")}.`);
  }
  const implemented = recipes.find((recipe) => recipe.maturity === "implemented");
  const planning = recipes.filter((recipe) => recipe.maturity !== "implemented");
  if (implemented) {
    steps.push(`Use the ${implemented.name} recipe: ${implemented.planSteps.join(" ")}`);
  } else if (planning.length > 0) {
    steps.push(
      `Recipe support is planned but not implemented yet: ${planning.map((recipe) => recipe.name).join(", ")}.`
    );
  } else {
    steps.push("Add or select a deployment recipe before deploying.");
  }
  if (host.webServers.caddy?.available || host.webServers.nginx?.available) {
    steps.push("Configure the detected web server and run an HTTP health check.");
  } else {
    steps.push("Install or configure Caddy/nginx before exposing HTTP traffic.");
  }
  return steps;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 5_000
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `Timed out after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, stdout, stderr: error.message, exitCode: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function parseKeyValueLines(content: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      output[match[1]] = match[2].replace(/^"|"$/g, "");
    }
  }
  return output;
}

function splitSections(stdout: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current = "default";
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("__OUTPOST_")) {
      current = line.trim();
      sections[current] = [];
    } else if (line) {
      sections[current] ??= [];
      sections[current].push(line);
    }
  }
  return sections;
}

function parseCommandMap(lines: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf("=");
    if (index !== -1) {
      output[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return output;
}

function availabilityFromMap(
  commandMap: Record<string, string>,
  command: string,
  version?: string
): ToolAvailability {
  const path = commandMap[command]?.trim();
  return {
    available: Boolean(path),
    path: path || undefined,
    version: version?.trim() || undefined
  };
}

function firstAvailable(
  commandMap: Record<string, string>,
  commands: string[]
): string | undefined {
  return commands.find((command) => Boolean(commandMap[command]?.trim()));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assertSshTarget(value: string): string {
  const target = value.trim();
  if (!/^[a-zA-Z0-9._@:-]+$/.test(target)) {
    throw new Error("sshTarget must look like user@host or host and cannot contain spaces");
  }
  return target;
}
