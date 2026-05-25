import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists, readJsonFile, writeJsonFile } from "@outpost/shared";
import {
  createPairingCommand,
  loadMothershipState,
  mothershipPaths,
  saveMothershipConfig
} from "./state.js";

export type BootstrapRequest = {
  sshTarget: string;
  repo: string;
  beaconUrl?: string;
  projectPath?: string;
  displayName?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDir?: string;
  retainReleases?: number;
  deploy?: boolean;
  runtimeSource?: "local" | "npm";
  localRuntimePath?: string;
  remoteRuntimePath?: string;
  startBeacon?: boolean;
  beaconPort?: number;
};

export type BootstrapOperation = {
  id: string;
  status: "running" | "success" | "failed";
  sshTarget: string;
  repo: string;
  repoKind: "local" | "remote";
  projectPath: string;
  beaconUrl: string;
  runtimeSource: "local" | "npm";
  localRuntimePath?: string;
  remoteRuntimePath?: string;
  startBeacon: boolean;
  beaconPort?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  logs: Array<{ stream: "stdout" | "stderr" | "system"; line: string; createdAt: string }>;
};

export async function listBootstrapOperations(): Promise<BootstrapOperation[]> {
  const path = mothershipPaths().bootstrapOperations;
  if (!(await pathExists(path))) {
    return [];
  }
  return readJsonFile<BootstrapOperation[]>(path);
}

export async function startBootstrap(input: BootstrapRequest): Promise<BootstrapOperation> {
  const sshTarget = assertSshTarget(input.sshTarget);
  const repo = input.repo.trim();
  if (!repo) {
    throw new Error("repo is required");
  }
  const repoKind = await detectRepoKind(repo);
  const localRuntimePath =
    input.runtimeSource === "npm" ? undefined : await resolveLocalRuntimePath(input);
  const runtimeSource = input.runtimeSource ?? (localRuntimePath ? "local" : "npm");
  if (runtimeSource === "local" && !localRuntimePath) {
    throw new Error(
      "Local Outpost runtime source was requested, but no local monorepo root was found."
    );
  }
  const startBeacon = input.startBeacon === true;
  const beaconPort = input.beaconPort ?? 8787;
  const beaconUrl =
    input.beaconUrl?.trim() ||
    (startBeacon ? beaconUrlForSshTarget(sshTarget, beaconPort) : undefined);
  if (startBeacon && runtimeSource !== "local") {
    throw new Error("startBeacon requires runtimeSource=local so the Beacon package can be run.");
  }
  if (startBeacon && beaconUrl) {
    await ensureMothershipBeaconConfigured(beaconUrl);
  }
  const projectName = input.displayName?.trim() || projectNameFromRepo(repo);
  const projectPath = sanitizeRemotePath(input.projectPath || `outpost-apps/${projectName}`);
  const remoteRuntimePath = sanitizeRemotePath(
    input.remoteRuntimePath || ".outpost/runtime/outpost"
  );
  const pairing = await createPairingCommand({
    beaconUrl,
    displayName: projectName,
    buildHints: {
      installCommand: input.installCommand,
      buildCommand: input.buildCommand,
      outputDir: input.outputDir,
      projectName,
      retainReleases: input.retainReleases
    }
  });
  const operation: BootstrapOperation = {
    id: `boot_${Date.now().toString(36)}`,
    status: "running",
    sshTarget,
    repo,
    repoKind,
    projectPath,
    beaconUrl: pairing.payload.beaconUrl,
    runtimeSource,
    localRuntimePath: runtimeSource === "local" ? localRuntimePath : undefined,
    remoteRuntimePath: runtimeSource === "local" ? remoteRuntimePath : undefined,
    startBeacon,
    beaconPort: startBeacon ? beaconPort : undefined,
    startedAt: new Date().toISOString(),
    logs: []
  };
  await saveOperation(operation);
  void runBootstrap(operation, pairing.encoded, input.deploy === true);
  return operation;
}

async function runBootstrap(
  operation: BootstrapOperation,
  pairingToken: string,
  deploy: boolean
): Promise<void> {
  try {
    appendLog(operation, "system", `Connecting to ${operation.sshTarget}`);
    if (operation.runtimeSource === "local") {
      await bootstrapLocalRuntime(operation);
    }
    const exitCode =
      operation.repoKind === "local"
        ? await bootstrapLocalRepo(operation, pairingToken, deploy)
        : await bootstrapRemoteRepo(operation, pairingToken, deploy);
    operation.exitCode = exitCode;
    operation.status = exitCode === 0 ? "success" : "failed";
    if (exitCode !== 0) {
      operation.error = `Bootstrap exited with code ${exitCode}`;
    }
  } catch (error) {
    operation.status = "failed";
    operation.error = error instanceof Error ? error.message : String(error);
    appendLog(operation, "stderr", operation.error);
  } finally {
    operation.finishedAt = new Date().toISOString();
    await saveOperation(operation);
  }
}

function buildRuntimeProvisioningScript(): string {
  return [
    "# Self-healing runtime installation",
    "if ! command -v git >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then",
    "  echo 'Mothership: Installing git and curl dependencies...'",
    "  sudo apt-get update -y && sudo apt-get install -y git curl || true",
    "  if ! command -v node >/dev/null 2>&1; then",
    "    echo 'Mothership: Installing NodeJS 20...'",
    "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || true",
    "    sudo apt-get install -y nodejs || true",
    "  fi",
    "fi",
    "if ! command -v docker >/dev/null 2>&1; then",
    "  echo 'Mothership: Installing Docker runtime...'",
    "  sudo apt-get update -y && sudo apt-get install -y docker.io || true",
    "  sudo systemctl start docker || true",
    "  sudo systemctl enable docker || true",
    "fi",
    ""
  ].join("\n");
}

async function bootstrapRemoteRepo(
  operation: BootstrapOperation,
  pairingToken: string,
  deploy: boolean
): Promise<number> {
  const deploySteps = [
    "set -e",
    remotePathAssignments(operation),
    buildRuntimeProvisioningScript(),
    'mkdir -p "$(dirname "$PROJECT_DIR")"',
    `if [ -d "$PROJECT_DIR/.git" ]; then git -C "$PROJECT_DIR" fetch --all --prune; else rm -rf "$PROJECT_DIR" && git clone ${shellQuote(operation.repo)} "$PROJECT_DIR"; fi`,
    'cd "$PROJECT_DIR"',
    daemonSetupCommand(operation, pairingToken, deploy),
    startBeaconCommand(operation),
    startDaemonCommand(operation)
  ].filter(Boolean);
  return runProcess(operation, "ssh", [operation.sshTarget, deploySteps.join("\n")]);
}

async function bootstrapLocalRepo(
  operation: BootstrapOperation,
  pairingToken: string,
  deploy: boolean
): Promise<number> {
  const localPath = expandLocalPath(operation.repo);
  const stat = await lstat(localPath);
  if (!stat.isDirectory()) {
    throw new Error(`Local repo must be a directory: ${localPath}`);
  }
  const remotePrepare = [
    "set -e",
    remotePathAssignments(operation),
    'rm -rf "$PROJECT_DIR"',
    'mkdir -p "$PROJECT_DIR"'
  ].join("\n");
  const prepareCode = await runProcess(operation, "ssh", [operation.sshTarget, remotePrepare]);
  if (prepareCode !== 0) {
    return prepareCode;
  }

  const tar = spawn("tar", ["-czf", "-", "-C", dirname(localPath), basename(localPath)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ssh = spawn(
    "ssh",
    [
      operation.sshTarget,
      `${remotePathAssignments(operation)}\ntar -xzf - -C "$PROJECT_DIR" --strip-components=1`
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  tar.stdout.pipe(ssh.stdin);
  pipeLogs(operation, "stderr", tar.stderr);
  pipeLogs(operation, "stdout", ssh.stdout);
  pipeLogs(operation, "stderr", ssh.stderr);
  const copyCode = await waitForPipedProcesses(tar, ssh);
  if (copyCode !== 0) {
    return copyCode;
  }

  const deploySteps = [
    "set -e",
    remotePathAssignments(operation),
    buildRuntimeProvisioningScript(),
    'cd "$PROJECT_DIR"',
    daemonSetupCommand(operation, pairingToken, deploy),
    startBeaconCommand(operation),
    startDaemonCommand(operation)
  ].filter(Boolean);
  return runProcess(operation, "ssh", [operation.sshTarget, deploySteps.join("\n")]);
}

async function bootstrapLocalRuntime(operation: BootstrapOperation): Promise<void> {
  if (!operation.localRuntimePath || !operation.remoteRuntimePath) {
    throw new Error("Local runtime paths are missing from bootstrap operation.");
  }

  appendLog(
    operation,
    "system",
    `Transferring local Beacon and Outpost runtime from ${operation.localRuntimePath}`
  );
  const prepare = [
    "set -e",
    remotePathAssignments(operation),
    buildRuntimeProvisioningScript(),
    'rm -rf "$RUNTIME_DIR"',
    'mkdir -p "$RUNTIME_DIR"'
  ].join("\n");
  const prepareCode = await runProcess(operation, "ssh", [operation.sshTarget, prepare]);
  if (prepareCode !== 0) {
    throw new Error(`Runtime prepare failed with code ${prepareCode}`);
  }

  const copyCode = await transferDirectory(operation, operation.localRuntimePath, "$RUNTIME_DIR");
  if (copyCode !== 0) {
    throw new Error(`Runtime transfer failed with code ${copyCode}`);
  }

  appendLog(operation, "system", "Installing and building transferred Outpost runtime");
  const buildCode = await runProcess(operation, "ssh", [
    operation.sshTarget,
    [
      "set -e",
      remotePathAssignments(operation),
      'cd "$RUNTIME_DIR"',
      "npm install",
      "npm run build"
    ].join("\n")
  ]);
  if (buildCode !== 0) {
    throw new Error(`Runtime build failed with code ${buildCode}`);
  }
}

function daemonSetupCommand(
  operation: BootstrapOperation,
  pairingToken: string,
  deploy: boolean
): string {
  const executable =
    operation.runtimeSource === "local"
      ? 'node "$RUNTIME_DIR/packages/daemon/dist/cli.js"'
      : "npx @outpost/daemon";
  return [
    `${executable} setup`,
    "--pair",
    shellQuote(pairingToken),
    "--no-start",
    deploy ? "--deploy" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function startBeaconCommand(operation: BootstrapOperation): string {
  if (!operation.startBeacon) {
    return "";
  }
  const port = operation.beaconPort ?? 8787;
  return [
    'mkdir -p "${RUNTIME_DIR:-$HOME/.outpost/runtime}/logs"',
    `nohup env PORT=${port} HOST=0.0.0.0 ${beaconExecutable()} > "\${RUNTIME_DIR:-$HOME/.outpost/runtime}/logs/beacon.log" 2>&1 &`
  ].join("\n");
}

function startDaemonCommand(operation: BootstrapOperation): string {
  const executable =
    operation.runtimeSource === "local"
      ? 'node "$RUNTIME_DIR/packages/daemon/dist/cli.js"'
      : "npx @outpost/daemon";
  return [
    'mkdir -p "$PROJECT_DIR/.outpost/logs"',
    `nohup ${executable} start > "$PROJECT_DIR/.outpost/logs/daemon.log" 2>&1 &`
  ].join("\n");
}

function beaconExecutable(): string {
  return 'node "$RUNTIME_DIR/packages/beacon/dist/cli.js"';
}

function runProcess(
  operation: BootstrapOperation,
  command: string,
  args: string[]
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    pipeLogs(operation, "stdout", child.stdout);
    pipeLogs(operation, "stderr", child.stderr);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function pipeLogs(
  operation: BootstrapOperation,
  stream: "stdout" | "stderr",
  readable: NodeJS.ReadableStream
): void {
  readable.setEncoding("utf8");
  readable.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line) {
        appendLog(operation, stream, line);
      }
    }
  });
}

function waitForPipedProcesses(
  tar: ReturnType<typeof spawn>,
  ssh: ReturnType<typeof spawn>
): Promise<number> {
  return new Promise((resolve) => {
    let tarCode: number | null = null;
    let sshCode: number | null = null;
    const maybeDone = () => {
      if (tarCode !== null && sshCode !== null) {
        resolve(tarCode === 0 ? sshCode : tarCode);
      }
    };
    tar.on("close", (code) => {
      tarCode = code ?? 1;
      ssh.stdin?.end();
      maybeDone();
    });
    ssh.on("close", (code) => {
      sshCode = code ?? 1;
      maybeDone();
    });
  });
}

async function saveOperation(operation: BootstrapOperation): Promise<void> {
  const operations = (await listBootstrapOperations()).filter((item) => item.id !== operation.id);
  operations.unshift({ ...operation, logs: operation.logs.slice(-300) });
  await writeJsonFile(mothershipPaths().bootstrapOperations, operations.slice(0, 50));
}

function appendLog(
  operation: BootstrapOperation,
  stream: "stdout" | "stderr" | "system",
  line: string
): void {
  operation.logs = [...operation.logs, { stream, line, createdAt: new Date().toISOString() }].slice(
    -300
  );
  void saveOperation(operation);
}

async function detectRepoKind(repo: string): Promise<"local" | "remote"> {
  if (repo.startsWith(".") || repo.startsWith("/") || repo.startsWith("~")) {
    return "local";
  }
  if (await pathExists(resolve(repo))) {
    return "local";
  }
  return "remote";
}

function expandLocalPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

async function resolveLocalRuntimePath(input: BootstrapRequest): Promise<string | undefined> {
  const explicit = input.localRuntimePath ?? process.env.OUTPOST_RUNTIME_SOURCE;
  if (explicit) {
    const localPath = expandLocalPath(explicit);
    await assertRuntimeRoot(localPath);
    return localPath;
  }
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    const detected = await findRuntimeRoot(start);
    if (detected) {
      return detected;
    }
  }
  return undefined;
}

async function findRuntimeRoot(start: string): Promise<string | undefined> {
  let current = resolve(start);
  while (current !== dirname(current)) {
    if (await isRuntimeRoot(current)) {
      return current;
    }
    current = dirname(current);
  }
  return (await isRuntimeRoot(current)) ? current : undefined;
}

async function assertRuntimeRoot(path: string): Promise<void> {
  if (!(await isRuntimeRoot(path))) {
    throw new Error(
      `Local runtime path must be the Outpost monorepo root with packages/beacon and packages/daemon: ${path}`
    );
  }
}

async function isRuntimeRoot(path: string): Promise<boolean> {
  return (
    (await pathExists(resolve(path, "package.json"))) &&
    (await pathExists(resolve(path, "packages", "beacon", "package.json"))) &&
    (await pathExists(resolve(path, "packages", "daemon", "package.json"))) &&
    (await pathExists(resolve(path, "packages", "protocol", "package.json"))) &&
    (await pathExists(resolve(path, "packages", "shared", "package.json")))
  );
}

async function ensureMothershipBeaconConfigured(beaconUrl: string): Promise<void> {
  const state = await loadMothershipState();
  const beacons = state.config.beacons ?? [{ url: state.config.beaconUrl }];
  if (beacons.some((beacon) => beacon.url === beaconUrl)) {
    return;
  }
  await saveMothershipConfig({
    ...state.config,
    beaconUrl: state.config.beaconUrl || beaconUrl,
    beacons: [...beacons, { url: beaconUrl, label: "bootstrapped-vps" }]
  });
}

function beaconUrlForSshTarget(sshTarget: string, port: number): string {
  const hostWithPort = sshTarget.split("@").pop() ?? sshTarget;
  const host = hostWithPort.startsWith("[")
    ? hostWithPort
    : hostWithPort.includes(":")
      ? hostWithPort.split(":")[0]
      : hostWithPort;
  return `ws://${host}:${port}`;
}

function projectNameFromRepo(repo: string): string {
  const trimmed = repo.replace(/\/$/, "");
  const name = basename(trimmed).replace(/\.git$/, "") || "app";
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

function assertSshTarget(value: string): string {
  const target = value.trim();
  if (!/^[a-zA-Z0-9._@:-]+$/.test(target)) {
    throw new Error("sshTarget must look like user@host or host and cannot contain spaces");
  }
  return target;
}

function sanitizeRemotePath(value: string): string {
  const path = value.trim().replace(/^~\//, "");
  if (!path || path.includes("\0") || path.startsWith("-")) {
    throw new Error("projectPath is invalid");
  }
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function remotePathAssignments(operation: BootstrapOperation): string {
  return [
    `PROJECT_DIR=${remotePathExpression(operation.projectPath)}`,
    operation.remoteRuntimePath
      ? `RUNTIME_DIR=${remotePathExpression(operation.remoteRuntimePath)}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function remotePathExpression(value: string): string {
  if (value.startsWith("/")) {
    return shellQuote(value);
  }
  return "${HOME}/" + shellQuote(value.replace(/^~\//, ""));
}

function transferDirectory(
  operation: BootstrapOperation,
  localPath: string,
  remoteDirectoryExpression: string
): Promise<number> {
  const tar = spawn(
    "tar",
    [
      "-czf",
      "-",
      "--exclude=.git",
      "--exclude=node_modules",
      "--exclude=*/node_modules",
      "--exclude=packages/*/dist",
      "--exclude=.outpost",
      "-C",
      dirname(localPath),
      basename(localPath)
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const ssh = spawn(
    "ssh",
    [
      operation.sshTarget,
      `${remotePathAssignments(operation)}\ntar -xzf - -C ${remoteDirectoryExpression} --strip-components=1`
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  tar.stdout.pipe(ssh.stdin);
  pipeLogs(operation, "stderr", tar.stderr);
  pipeLogs(operation, "stdout", ssh.stdout);
  pipeLogs(operation, "stderr", ssh.stderr);
  return waitForPipedProcesses(tar, ssh);
}
