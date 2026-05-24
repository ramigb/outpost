import { spawn } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, pathExists } from "@outpost/shared";
import { mothershipPaths } from "./state.js";

export type MothershipPlugin = {
  id: string;
  name: string;
  description: string;
  entry: string;
  createdAt: string;
  updatedAt: string;
};

export type PluginRunResult = {
  pluginId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function listPlugins(): Promise<MothershipPlugin[]> {
  const pluginsDir = mothershipPaths().plugins;
  if (!(await pathExists(pluginsDir))) {
    return [];
  }
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const plugins: MothershipPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = join(pluginsDir, entry.name, "plugin.json");
    if (await pathExists(manifestPath)) {
      plugins.push(JSON.parse(await readFile(manifestPath, "utf8")) as MothershipPlugin);
    }
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertPlugin(input: {
  id?: string;
  name: string;
  description?: string;
  code: string;
}): Promise<MothershipPlugin> {
  const id = sanitizePluginId(input.id || input.name);
  const pluginDir = join(mothershipPaths().plugins, id);
  const manifestPath = join(pluginDir, "plugin.json");
  const now = new Date().toISOString();
  const existing = (await pathExists(manifestPath))
    ? (JSON.parse(await readFile(manifestPath, "utf8")) as MothershipPlugin)
    : undefined;
  const plugin: MothershipPlugin = {
    id,
    name: input.name.trim() || id,
    description: input.description?.trim() || "Local Mothership tool",
    entry: "tool.mjs",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await ensureDir(pluginDir);
  await writeFile(manifestPath, `${JSON.stringify(plugin, null, 2)}\n`, "utf8");
  await writeFile(join(pluginDir, plugin.entry), input.code, { encoding: "utf8", mode: 0o755 });
  await chmod(join(pluginDir, plugin.entry), 0o755);
  return plugin;
}

export async function runPlugin(pluginId: string, input: unknown): Promise<PluginRunResult> {
  const id = sanitizePluginId(pluginId);
  const plugin = (await listPlugins()).find((item) => item.id === id);
  if (!plugin) {
    throw new Error(`Plugin not found: ${pluginId}`);
  }
  const entry = join(mothershipPaths().plugins, plugin.id, plugin.entry);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += "Plugin timed out after 30 seconds\n";
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ pluginId: plugin.id, exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

export function pluginTemplate(name: string): string {
  return `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

console.log(JSON.stringify({
  ok: true,
  plugin: ${JSON.stringify(name)},
  input
}, null, 2));
`;
}

function sanitizePluginId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) {
    throw new Error("Plugin id is required");
  }
  return id.slice(0, 80);
}
