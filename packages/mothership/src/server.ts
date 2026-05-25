/**
 * @module @outpost/mothership/server
 *
 * Mothership HTTP dashboard and API server.  Serves the single-page control room,
 * exposes REST endpoints for state, pairing, provisioning, AI chat, operations,
 * plugins, and Outpost command dispatch, and coordinates with the Beacon relay
 * via {@link MothershipBeaconHub}.
 */

import { createServer } from "node:http";
import WebSocket from "ws";
import { parseOutpostCommand } from "@outpost/protocol";
import { listDeploymentRecipes, recommendDeploymentRecipes } from "@outpost/shared";
import {
  askAiAgent,
  assertHarnessProviderReady,
  draftPlugin,
  getAiStatus,
  saveAiConfig,
  validateAiProvider
} from "./ai.js";
import { listBootstrapOperations, startBootstrap, type BootstrapRequest } from "./bootstrap.js";
import { MothershipBeaconHub } from "./beaconClient.js";
import { getAgentMemorySnapshot } from "./memory.js";
import { buildOutpostInventory, toolNameForOutpostCommand } from "./outposts.js";
import {
  appendOperationEvent,
  finishOperation,
  listOperations,
  markOperationApproved,
  type MothershipOperation
} from "./operations.js";
import { listPlugins, pluginTemplate, runPlugin, upsertPlugin } from "./plugins.js";
import {
  createLocalProvisioningPlan,
  detectLocalApp,
  inspectLocalHost,
  inspectSshHost,
  runHttpHealthCheck,
  runSshCommand
} from "./provisioning.js";
import {
  createPairingCommand,
  loadMothershipState,
  normalizeApprovalConfig,
  saveMothershipConfig,
  upsertOutpost,
  type ApprovalMode
} from "./state.js";
import { executeTool, listTools, type ToolRunContext } from "./tools.js";

/**
 * Starts the Mothership HTTP server and WebSocket beacon hub.
 *
 * @param input - Optional port and host overrides.
 * @returns A controller with a `close()` method.
 *
 * @example
 * ```ts
 * const server = await startMothershipServer({ port: 4173 });
 * // later
 * server.close();
 * ```
 */
export async function startMothershipServer(
  input: { port?: number; host?: string } = {}
): Promise<{ close: () => void }> {
  const port = input.port ?? Number(process.env.PORT ?? 4173);
  const host = input.host ?? process.env.HOST ?? "127.0.0.1";
  const state = await loadMothershipState();
  const beacon = new MothershipBeaconHub(state);
  beacon.connect();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(indexHtml());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        const current = await loadMothershipState();
        beacon.updateState(current);
        json(response, { ...current, privateKeyPem: undefined, beacon: beacon.snapshot() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pairing-payload") {
        const body = await readBody(request);
        json(
          response,
          await createPairingCommand({
            beaconUrl: typeof body.beaconUrl === "string" ? body.beaconUrl : undefined,
            displayName: typeof body.displayName === "string" ? body.displayName : undefined,
            buildHints: {
              installCommand:
                typeof body.installCommand === "string" ? body.installCommand : undefined,
              buildCommand: typeof body.buildCommand === "string" ? body.buildCommand : undefined,
              outputDir: typeof body.outputDir === "string" ? body.outputDir : undefined,
              projectName: typeof body.projectName === "string" ? body.projectName : undefined,
              retainReleases:
                typeof body.retainReleases === "number" && Number.isFinite(body.retainReleases)
                  ? body.retainReleases
                  : undefined
            }
          })
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/config") {
        const body = await readBody(request);
        const beacons = parseBeaconInputs(body);
        if (beacons.length === 0) {
          throw new Error("At least one beacon URL is required");
        }
        const current = await loadMothershipState();
        await saveMothershipConfig({
          ...current.config,
          beaconUrl: beacons[0].url,
          beacons,
          approvals:
            typeof body.approvalMode === "string"
              ? normalizeApprovalConfig({ mode: body.approvalMode as ApprovalMode })
              : current.config.approvals
        });
        beacon.reconnect(await loadMothershipState());
        json(response, { ok: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/beacon/check") {
        const body = await readBody(request);
        const beaconUrl =
          typeof body.beaconUrl === "string"
            ? body.beaconUrl
            : (await loadMothershipState()).config.beaconUrl;
        json(response, await checkBeacon(beaconUrl));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        json(response, { operations: await listBootstrapOperations() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/bootstrap") {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const requestInput = parseBootstrapRequest(body);
        const execution = await executeTool({
          toolName: "mothership.bootstrap_vps",
          title: `Bootstrap ${requestInput.sshTarget}`,
          target: requestInput.sshTarget,
          toolInput: requestInput,
          approved: body.approved === true,
          run: () => startBootstrap(requestInput)
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/provisioning/inspect-local") {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const execution = await executeTool({
          toolName: "host.inspect_local",
          title: "Inspect local host",
          target: "local",
          toolInput: {},
          approved: body.approved === true,
          run: (context) => inspectLocalHost(context)
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/provisioning/inspect-ssh") {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const sshTarget = typeof body.sshTarget === "string" ? body.sshTarget : "";
        const execution = await executeTool({
          toolName: "host.inspect_ssh",
          title: `Inspect ${sshTarget}`,
          target: sshTarget,
          toolInput: { sshTarget },
          approved: body.approved === true,
          run: (context) => inspectSshHost(sshTarget, context)
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/provisioning/run-ssh") {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const sshTarget = typeof body.sshTarget === "string" ? body.sshTarget : "";
        const command = typeof body.command === "string" ? body.command : "";
        const execution = await executeTool({
          toolName: "host.run_ssh_command",
          title: `Run command on ${sshTarget}`,
          target: sshTarget,
          toolInput: { sshTarget, command },
          approved: body.approved === true,
          run: (context) => runSshCommand(sshTarget, command, context)
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/provisioning/detect-app") {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const projectPath = typeof body.projectPath === "string" ? body.projectPath : ".";
        const execution = await executeTool({
          toolName: "app.detect_local",
          title: `Detect app ${projectPath}`,
          target: projectPath,
          toolInput: { projectPath },
          approved: body.approved === true,
          run: (context) => detectLocalApp(projectPath, context)
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/provisioning/plan-local") {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const projectPath = typeof body.projectPath === "string" ? body.projectPath : ".";
        const execution = await executeTool({
          toolName: "provisioning.plan_local",
          title: `Plan local deployment ${projectPath}`,
          target: projectPath,
          toolInput: { projectPath },
          approved: body.approved === true,
          run: (context) => createLocalProvisioningPlan(projectPath, context)
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/provisioning/health") {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const healthUrl = typeof body.url === "string" ? body.url : "";
        const timeoutMs =
          typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
            ? body.timeoutMs
            : undefined;
        const execution = await executeTool({
          toolName: "health.http_check",
          title: `Check ${healthUrl}`,
          target: healthUrl,
          toolInput: { url: healthUrl, timeoutMs },
          approved: body.approved === true,
          run: (context) => runHttpHealthCheck(healthUrl, timeoutMs, context)
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tools") {
        json(response, { tools: listTools() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/recipes") {
        json(response, { recipes: listDeploymentRecipes() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/recipes/recommend") {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const projectPath = typeof body.projectPath === "string" ? body.projectPath : ".";
        const execution = await executeTool({
          toolName: "recipes.recommend_local",
          title: `Recommend recipes ${projectPath}`,
          target: projectPath,
          toolInput: { projectPath },
          approved: body.approved === true,
          run: async (context) => {
            const app = await detectLocalApp(projectPath, context);
            return { app, recipes: recommendDeploymentRecipes(app.appTypes) };
          }
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/operations") {
        json(response, { operations: await listOperations() });
        return;
      }
      const operationApproveMatch = url.pathname.match(/^\/api\/operations\/([^/]+)\/approve$/);
      if (request.method === "POST" && operationApproveMatch) {
        const operation = (await listOperations()).find(
          (item) => item.id === decodeURIComponent(operationApproveMatch[1])
        );
        if (!operation) {
          throw new Error("Operation not found");
        }
        json(response, await approveStoredOperation(operation, beacon));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/plugins") {
        json(response, { plugins: await listPlugins() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/plugins") {
        const body = await readBody(request);
        const name = typeof body.name === "string" ? body.name : "";
        json(
          response,
          await upsertPlugin({
            id: typeof body.id === "string" ? body.id : undefined,
            name,
            description: typeof body.description === "string" ? body.description : undefined,
            code: typeof body.code === "string" ? body.code : pluginTemplate(name || "plugin")
          })
        );
        return;
      }
      const pluginRunMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/run$/);
      if (request.method === "POST" && pluginRunMatch) {
        json(
          response,
          await runPlugin(decodeURIComponent(pluginRunMatch[1]), await readBody(request))
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/ai") {
        json(response, await getAiStatus());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/ai/memory") {
        json(response, await getAgentMemorySnapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/ai") {
        const body = await readBody(request);
        json(
          response,
          await saveAiConfig({
            apiKey:
              typeof body.apiKey === "string" && body.apiKey.trim()
                ? body.apiKey.trim()
                : undefined,
            provider: typeof body.provider === "string" ? body.provider : undefined,
            baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
            defaultModel:
              typeof body.defaultModel === "string"
                ? body.defaultModel
                : typeof body.model === "string"
                  ? body.model
                  : undefined
          })
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/ai/validate") {
        const body = await readBody(request);
        const execution = await executeTool({
          toolName: "provider.validate",
          title: "Validate AI provider",
          toolInput: await getAiStatus(),
          approved: body.approved === true,
          run: validateAiProvider
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/ai/chat") {
        const body = await readBody(request);
        json(
          response,
          await askAiAgent({
            message: typeof body.message === "string" ? body.message : "",
            allowPluginWrite: body.allowPluginWrite === true,
            outposts: {
              snapshot: () => beacon.snapshot(),
              sendCommand: (peerId, command) => beacon.sendCommand(peerId, command)
            }
          })
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/ai/chat/stream") {
        const body = await readBody(request);
        const message = typeof body.message === "string" ? body.message : "";
        const allowPluginWrite = body.allowPluginWrite === true;

        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });

        try {
          const status = await getAiStatus();
          if (status.validationStatus !== "valid" && message.trim().toLowerCase() !== "/reset") {
            response.write(
              `data: ${JSON.stringify({ type: "error", message: `AI provider not validated. Current status: ${status.validationStatus}.` })}\n\n`
            );
            response.end();
            return;
          }

          const { askAiAgentStreamed } = await import("./ai.js");
          const stream = askAiAgentStreamed({
            message,
            allowPluginWrite,
            outposts: {
              snapshot: () => beacon.snapshot(),
              sendCommand: (peerId, command) => beacon.sendCommand(peerId, command)
            }
          });

          for await (const event of stream) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }

          response.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          response.end();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
          response.end();
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/ai/plugin-draft") {
        const body = await readBody(request);
        json(
          response,
          await draftPlugin({
            name: typeof body.name === "string" ? body.name : "plugin",
            description: typeof body.description === "string" ? body.description : undefined
          })
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/outposts") {
        const body = await readBody(request);
        if (typeof body.peerId !== "string") {
          throw new Error("peerId is required");
        }
        const outpost = await upsertOutpost({
          peerId: body.peerId,
          publicKeyPem: typeof body.publicKeyPem === "string" ? body.publicKeyPem : undefined
        });
        beacon.updateState(await loadMothershipState());
        json(response, outpost);
        return;
      }
      const commandMatch = url.pathname.match(/^\/api\/outposts\/([^/]+)\/commands$/);
      if (request.method === "POST" && commandMatch) {
        await assertHarnessProviderReady();
        const body = await readBody(request);
        const command = parseOutpostCommand(body);
        const peerId = commandMatch[1];
        const execution = await executeTool({
          toolName: toolNameForOutpostCommand(command),
          title: `${command.type} ${peerId}`,
          target: peerId,
          toolInput: { peerId, command },
          approved: body.approved === true,
          run: async () => ({
            envelope: beacon.sendCommand(peerId, command),
            beacon: beacon.snapshot()
          })
        });
        json(response, execution.approvalRequired ? execution : execution.result);
        return;
      }
      response.writeHead(404);
      response.end("not found");
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      );
    }
  });

  server.listen(port, host, () => {
    console.log(`Mothership listening on http://${host}:${port}`);
  });
  return {
    close: () => {
      beacon.close();
      server.close();
    }
  };
}

async function approveStoredOperation(
  operation: MothershipOperation,
  beacon: MothershipBeaconHub
): Promise<{ operation: MothershipOperation; result?: unknown }> {
  if (operation.approval.status !== "required" && operation.status !== "waiting_approval") {
    return { operation };
  }

  switch (operation.toolName) {
    case "provider.validate":
      return runApprovedStoredOperation(operation, validateAiProvider);
    case "host.inspect_local":
      return runApprovedStoredOperation(operation, (context) => inspectLocalHost(context));
    case "host.inspect_ssh": {
      const input = asRecord(operation.input);
      const sshTarget = requiredString(input, "sshTarget");
      return runApprovedStoredOperation(operation, (context) => inspectSshHost(sshTarget, context));
    }
    case "host.run_ssh_command": {
      const input = asRecord(operation.input);
      const sshTarget = requiredString(input, "sshTarget");
      const command = requiredString(input, "command");
      return runApprovedStoredOperation(operation, (context) =>
        runSshCommand(sshTarget, command, context)
      );
    }
    case "app.detect_local": {
      const input = asRecord(operation.input);
      const projectPath = optionalString(input, "projectPath") ?? ".";
      return runApprovedStoredOperation(operation, (context) =>
        detectLocalApp(projectPath, context)
      );
    }
    case "health.http_check": {
      const input = asRecord(operation.input);
      const healthUrl = requiredString(input, "url");
      const timeoutMs =
        typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
          ? input.timeoutMs
          : undefined;
      return runApprovedStoredOperation(operation, (context) =>
        runHttpHealthCheck(healthUrl, timeoutMs, context)
      );
    }
    case "provisioning.plan_local": {
      const input = asRecord(operation.input);
      const projectPath = optionalString(input, "projectPath") ?? ".";
      return runApprovedStoredOperation(operation, (context) =>
        createLocalProvisioningPlan(projectPath, context)
      );
    }
    case "recipes.list":
      return runApprovedStoredOperation(operation, async () => ({
        recipes: listDeploymentRecipes()
      }));
    case "recipes.recommend_local": {
      const input = asRecord(operation.input);
      const projectPath = optionalString(input, "projectPath") ?? ".";
      return runApprovedStoredOperation(operation, async (context) => {
        const app = await detectLocalApp(projectPath, context);
        return { app, recipes: recommendDeploymentRecipes(app.appTypes) };
      });
    }
    case "mothership.bootstrap_vps": {
      const input = asRecord(operation.input);
      const requestInput = parseBootstrapRequest(input);
      return runApprovedStoredOperation(operation, () => startBootstrap(requestInput));
    }
    case "outpost.list":
      return runApprovedStoredOperation(operation, async () =>
        buildOutpostInventory(await loadMothershipState(), beacon.snapshot())
      );
    case "outpost.create_pairing": {
      const input = asRecord(operation.input);
      return runApprovedStoredOperation(operation, () =>
        createPairingCommand({
          beaconUrl: optionalString(input, "beaconUrl"),
          displayName: optionalString(input, "displayName"),
          buildHints: {
            installCommand: optionalString(input, "installCommand"),
            buildCommand: optionalString(input, "buildCommand"),
            outputDir: optionalString(input, "outputDir"),
            projectName: optionalString(input, "projectName"),
            retainReleases:
              typeof input.retainReleases === "number" && Number.isFinite(input.retainReleases)
                ? input.retainReleases
                : undefined
          }
        })
      );
    }
    case "outpost.inspect":
    case "outpost.doctor":
    case "outpost.deploy":
    case "outpost.rollback":
    case "outpost.set_env":
    case "outpost.apply_recipe": {
      const input = asRecord(operation.input);
      const peerId = requiredString(input, "peerId");
      const command = parseOutpostCommand(input.command);
      return runApprovedStoredOperation(operation, async () => ({
        envelope: beacon.sendCommand(peerId, command),
        beacon: beacon.snapshot()
      }));
    }
    default:
      throw new Error(`Approval resume is not implemented for ${operation.toolName}`);
  }
}

async function runApprovedStoredOperation<TResult>(
  operation: MothershipOperation,
  run: (context: ToolRunContext) => Promise<TResult>
): Promise<{ operation: MothershipOperation; result?: TResult }> {
  await markOperationApproved(operation);
  await appendOperationEvent(operation, {
    level: "success",
    phase: "approval",
    message: "Operation approved from the dashboard",
    toolName: operation.toolName,
    target: operation.target
  });
  await appendOperationEvent(operation, {
    level: "info",
    phase: "tool",
    message: `Running ${operation.toolName}`,
    toolName: operation.toolName,
    target: operation.target
  });

  try {
    const context: ToolRunContext = {
      operation,
      emit: async (event) => {
        await appendOperationEvent(operation, event);
      }
    };
    const result = await run(context);
    await appendOperationEvent(operation, {
      level: "success",
      phase: "tool",
      message: `${operation.toolName} completed`,
      toolName: operation.toolName,
      target: operation.target
    });
    await finishOperation(operation, { status: "success", result });
    return { operation, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendOperationEvent(operation, {
      level: "error",
      phase: "tool",
      message,
      toolName: operation.toolName,
      target: operation.target
    });
    await finishOperation(operation, { status: "failed", error: message });
    throw error;
  }
}

function parseBeaconInputs(body: Record<string, unknown>): Array<{ url: string; label?: string }> {
  if (Array.isArray(body.beacons)) {
    return body.beacons
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        url: typeof item.url === "string" ? item.url.trim() : "",
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : undefined
      }))
      .filter((item) => item.url.length > 0);
  }
  if (typeof body.beaconUrls === "string") {
    return body.beaconUrls
      .split(/\r?\n|,/)
      .map((url) => ({ url: url.trim() }))
      .filter((item) => item.url.length > 0);
  }
  if (typeof body.beaconUrl === "string") {
    return [{ url: body.beaconUrl.trim() }].filter((item) => item.url.length > 0);
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBootstrapRequest(body: Record<string, unknown>): BootstrapRequest {
  return {
    sshTarget: typeof body.sshTarget === "string" ? body.sshTarget : "",
    repo: typeof body.repo === "string" ? body.repo : "",
    beaconUrl:
      typeof body.beaconUrl === "string" && body.beaconUrl.trim()
        ? body.beaconUrl.trim()
        : undefined,
    projectPath:
      typeof body.projectPath === "string" && body.projectPath.trim()
        ? body.projectPath.trim()
        : undefined,
    displayName:
      typeof body.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim()
        : undefined,
    installCommand:
      typeof body.installCommand === "string" && body.installCommand.trim()
        ? body.installCommand.trim()
        : undefined,
    buildCommand:
      typeof body.buildCommand === "string" && body.buildCommand.trim()
        ? body.buildCommand.trim()
        : undefined,
    outputDir:
      typeof body.outputDir === "string" && body.outputDir.trim()
        ? body.outputDir.trim()
        : undefined,
    retainReleases:
      typeof body.retainReleases === "number" && Number.isFinite(body.retainReleases)
        ? body.retainReleases
        : undefined,
    deploy: body.deploy === true,
    runtimeSource:
      body.runtimeSource === "local" || body.runtimeSource === "npm"
        ? body.runtimeSource
        : undefined,
    localRuntimePath:
      typeof body.localRuntimePath === "string" && body.localRuntimePath.trim()
        ? body.localRuntimePath.trim()
        : undefined,
    remoteRuntimePath:
      typeof body.remoteRuntimePath === "string" && body.remoteRuntimePath.trim()
        ? body.remoteRuntimePath.trim()
        : undefined,
    startBeacon: body.startBeacon === true,
    beaconPort:
      typeof body.beaconPort === "number" && Number.isFinite(body.beaconPort)
        ? body.beaconPort
        : undefined
  };
}

async function checkBeacon(beaconUrl: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(beaconUrl);
    const timeout = setTimeout(() => {
      socket.close();
      resolve({ ok: false, message: "Beacon connection timed out" });
    }, 3_000);
    socket.on("open", () => {
      clearTimeout(timeout);
      socket.close();
      resolve({ ok: true, message: "Beacon is reachable" });
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, message: error.message });
    });
  });
}

function json(
  response: {
    writeHead: (statusCode: number, headers?: Record<string, string>) => void;
    end: (body?: string) => void;
  },
  value: unknown
): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value, null, 2));
}

async function readBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function indexHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Outpost Mothership Control Room</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #060813;
      --bg-sidebar: #0b0f19;
      --bg-card: #151b2d;
      --bg-input: #0a0d16;
      --border-color: rgba(255, 255, 255, 0.08);
      --border-focus: #10b981;
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --text-muted: #6b7280;
      --color-primary: #10b981;
      --color-primary-hover: #34d399;
      --color-primary-glow: rgba(16, 185, 129, 0.15);
      --color-secondary: #3b82f6;
      --color-secondary-hover: #60a5fa;
      --color-danger: #ef4444;
      --color-warning: #f59e0b;
      --color-info: #3b82f6;
      --font-ui: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      margin: 0;
      font-family: var(--font-ui);
      background: var(--bg-base);
      color: var(--text-primary);
      height: 100vh;
      overflow: hidden;
    }
    .app-container {
      display: flex;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
    }
    .sidebar {
      width: 400px;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      transition: width 0.22s ease;
      overflow: hidden;
    }
    .sidebar.collapsed {
      width: 46px;
    }
    .sidebar-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .sidebar.collapsed .sidebar-header {
      padding: 8px 6px;
      justify-content: center;
    }
    .sidebar.collapsed .brand,
    .sidebar.collapsed .sidebar-tabs,
    .sidebar.collapsed .sidebar-content,
    .sidebar.collapsed #beacon-pill {
      display: none;
    }
    .sidebar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .setup-toggle {
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 6px;
      font-size: 10px;
      line-height: 1;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-logo {
      width: 28px;
      height: 28px;
      fill: var(--color-primary);
    }
    .brand h2 {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand .subtitle {
      font-size: 11px;
      color: var(--text-secondary);
    }
    .sidebar-tabs {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border-bottom: 1px solid var(--border-color);
      background: rgba(0,0,0,0.15);
    }
    .tab-btn {
      background: none;
      border: 0;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      padding: 12px 2px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.2s ease;
    }
    .tab-btn:hover {
      color: var(--text-primary);
      background: rgba(255,255,255,0.02);
    }
    .tab-btn.active {
      color: var(--color-primary);
      border-bottom-color: var(--color-primary);
      background: rgba(16, 185, 129, 0.04);
    }
    .sidebar-content {
      flex-grow: 1;
      overflow-y: auto;
      padding: 20px;
    }
    .tab-pane {
      display: none;
    }
    .tab-pane.active {
      display: block;
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .section-title h3 {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .icon-btn {
      background: none;
      border: 0;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 15px;
      padding: 4px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .icon-btn:hover {
      color: var(--text-primary);
      background: rgba(255,255,255,0.05);
    }
    .settings-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 16px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    .settings-card h3 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
      border-left: 3px solid var(--color-primary);
      padding-left: 8px;
    }
    .form-group {
      margin-bottom: 12px;
    }
    .form-group label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-bottom: 12px;
    }
    input, select, textarea {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      color: var(--text-primary);
      padding: 8px 10px;
      font-family: inherit;
      font-size: 12.5px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.12);
    }
    textarea {
      resize: vertical;
    }
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
    }
    .checkbox-group input[type="checkbox"] {
      width: auto;
      cursor: pointer;
    }
    .checkbox-group label {
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
    }
    button {
      font-family: var(--font-ui);
      font-size: 12.5px;
      font-weight: 600;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn-block {
      width: 100%;
      padding: 9px 12px;
      background: var(--color-primary);
      color: #fff;
    }
    .btn-block:hover {
      background: var(--color-primary-hover);
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.2);
    }
    .btn-group {
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }
    .btn-group button {
      flex: 1;
      padding: 8px 10px;
    }
    button:not(.btn-secondary):not(.tab-btn):not(.icon-btn):not(.chip):not(.dropdown-item):not(.btn-approve) {
      background: var(--color-primary);
      color: #fff;
    }
    button:not(.btn-secondary):not(.tab-btn):not(.icon-btn):not(.chip):not(.dropdown-item):not(.btn-approve):hover {
      background: var(--color-primary-hover);
    }
    .btn-secondary {
      background: rgba(255,255,255,0.06);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }
    .btn-secondary:hover {
      background: rgba(255,255,255,0.1);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .outposts-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .outpost-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 12px;
      transition: border-color 0.2s;
    }
    .outpost-card:hover {
      border-color: rgba(16, 185, 129, 0.25);
    }
    .outpost-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 8px;
    }
    .outpost-name h4 {
      font-size: 13px;
      font-weight: 600;
    }
    .outpost-name .host-label {
      font-size: 10.5px;
      color: var(--text-secondary);
      margin-top: 1px;
    }
    .status-badge {
      font-size: 9px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .status-badge.online {
      background: rgba(16, 185, 129, 0.12);
      color: var(--color-primary);
      border: 1px solid rgba(16, 185, 129, 0.2);
    }
    .status-badge.offline {
      background: rgba(239, 68, 68, 0.08);
      color: var(--color-danger);
      border: 1px solid rgba(239, 68, 68, 0.15);
    }
    .outpost-metrics {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      margin-bottom: 10px;
      background: rgba(0,0,0,0.12);
      padding: 6px;
      border-radius: 6px;
    }
    .metric-item {
      font-size: 10.5px;
    }
    .metric-item span {
      color: var(--text-secondary);
    }
    .metric-item b {
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 9.5px;
      font-weight: 500;
    }
    .outpost-actions {
      display: flex;
      gap: 6px;
    }
    .outpost-actions button {
      padding: 5px 8px;
      font-size: 11.5px;
    }
    .outpost-actions .btn-deploy {
      flex-grow: 1;
    }
    .actions-dropdown {
      position: relative;
    }
    .actions-dropdown summary {
      list-style: none;
      padding: 5px 8px;
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      cursor: pointer;
      font-size: 11.5px;
      font-weight: 600;
    }
    .actions-dropdown summary::-webkit-details-marker {
      display: none;
    }
    .actions-dropdown summary:hover {
      background: rgba(255,255,255,0.1);
    }
    .dropdown-menu {
      position: absolute;
      bottom: 100%;
      right: 0;
      margin-bottom: 4px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4);
      z-index: 100;
      width: 170px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .dropdown-item {
      padding: 7px 10px;
      background: none !important;
      border: 0;
      color: var(--text-primary) !important;
      text-align: left;
      cursor: pointer;
      width: 100%;
      font-size: 11.5px;
      font-weight: 500;
      transition: background 0.15s;
    }
    .dropdown-item:hover {
      background: rgba(255,255,255,0.05) !important;
      color: var(--color-primary) !important;
    }
    .release-history-details {
      margin-top: 8px;
      border-top: 1px solid var(--border-color);
      padding-top: 6px;
    }
    .release-history-details summary {
      list-style: none;
      cursor: pointer;
      font-size: 10px;
      color: var(--text-secondary);
      font-weight: 600;
      display: flex;
      justify-content: space-between;
    }
    .release-history-details summary::after {
      content: '▾';
    }
    .release-history-details[open] summary::after {
      content: '▴';
    }
    .releases-container {
      margin-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-height: 120px;
      overflow-y: auto;
      padding-right: 2px;
    }
    .release-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 6px;
      background: rgba(0,0,0,0.1);
      border-radius: 4px;
      font-size: 10.5px;
    }
    .release-info b {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-primary);
    }
    .release-info div {
      font-size: 8.5px;
      color: var(--text-secondary);
      margin-top: 1px;
    }
    .release-row button {
      padding: 2px 5px;
      font-size: 9.5px;
    }
    .console-box {
      font-family: var(--font-mono);
      font-size: 10.5px;
      background: #030611;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 8px;
      color: #10b981;
      overflow-x: auto;
      max-height: 160px;
      margin-top: 6px;
      white-space: pre-wrap;
    }
    .validation-status {
      font-size: 11.5px;
      margin-top: 8px;
      padding: 6px;
      border-radius: 6px;
      background: rgba(255,255,255,0.03);
    }
    .catalog-section {
      margin-bottom: 16px;
    }
    .catalog-section h3 {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .catalog-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .catalog-item {
      background: rgba(255,255,255,0.01);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .catalog-item-info h4 {
      font-size: 12px;
      font-weight: 600;
    }
    .catalog-item-info p {
      font-size: 10px;
      color: var(--text-secondary);
      margin-top: 1px;
    }
    .catalog-badge {
      font-size: 8.5px;
      font-family: var(--font-mono);
      padding: 1px 4px;
      background: rgba(255,255,255,0.04);
      border-radius: 3px;
      color: var(--text-secondary);
    }
    .chat-workspace {
      flex-grow: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base);
    }
    .workspace-header {
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(11, 15, 25, 0.4);
      backdrop-filter: blur(8px);
    }
    .system-status-bar {
      display: flex;
      gap: 16px;
    }
    .status-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--text-muted);
      position: relative;
    }
    .status-dot.online {
      background: var(--color-primary);
      box-shadow: 0 0 6px var(--color-primary);
      animation: pulse 2s infinite;
    }
    .status-dot.warning {
      background: var(--color-warning);
      box-shadow: 0 0 6px var(--color-warning);
      animation: pulse 2s infinite;
    }
    .status-dot.offline {
      background: var(--color-danger);
      box-shadow: 0 0 6px var(--color-danger);
    }
    .status-label {
      font-size: 11.5px;
      font-weight: 500;
      color: var(--text-secondary);
    }
    .chat-messages {
      flex-grow: 1;
      min-width: 0;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .message-wrapper {
      display: flex;
      flex-direction: column;
      max-width: 80%;
      min-width: 0;
      animation: fadeIn 0.25s ease-out;
    }
    .message-wrapper.user {
      align-self: flex-end;
    }
    .message-wrapper.operator {
      align-self: flex-start;
    }
    .message-wrapper.system {
      align-self: center;
      max-width: 90%;
    }
    .message-sender {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 3px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .message-wrapper.user .message-sender {
      text-align: right;
    }
    .message-bubble {
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.45;
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .message-wrapper.user .message-bubble {
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
      border-bottom-right-radius: 2px;
      box-shadow: 0 3px 8px rgba(16, 185, 129, 0.15);
    }
    .message-wrapper.operator .message-bubble {
      background: var(--bg-card);
      color: var(--text-primary);
      border-bottom-left-radius: 2px;
      border: 1px solid var(--border-color);
      box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }
    .message-wrapper.system .message-bubble {
      background: rgba(255,255,255,0.01);
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 11px;
      text-align: center;
    }
    .message-bubble p {
      margin-bottom: 6px;
    }
    .message-bubble p:last-child {
      margin-bottom: 0;
    }
    .message-bubble ul {
      margin-left: 16px;
      margin-bottom: 6px;
    }
    .message-bubble li {
      margin-bottom: 3px;
    }
    .inline-code {
      font-family: var(--font-mono);
      font-size: 11px;
      background: rgba(0,0,0,0.35);
      padding: 1px 4px;
      border-radius: 3px;
      color: #34d399;
    }
    .code-block {
      font-family: var(--font-mono);
      font-size: 11px;
      background: #030611;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      margin: 8px 0;
      overflow: hidden;
    }
    .code-header {
      background: rgba(255,255,255,0.02);
      padding: 3px 8px;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border-color);
      color: var(--text-secondary);
    }
    .code-block code {
      display: block;
      padding: 8px;
      overflow-x: auto;
      white-space: pre;
    }
    .suggestion-chips {
      padding: 0 20px;
      display: flex;
      gap: 6px;
      overflow-x: auto;
      margin-bottom: 10px;
      flex-shrink: 0;
    }
    .suggestion-chips::-webkit-scrollbar {
      display: none;
    }
    .chip {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 11px;
      white-space: nowrap;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.15s;
    }
    .chip:hover {
      background: rgba(16, 185, 129, 0.08);
      border-color: rgba(16, 185, 129, 0.3);
      color: var(--color-primary);
    }
    .chat-input-container {
      padding: 12px 20px 20px;
      border-top: 1px solid var(--border-color);
      background: rgba(11, 15, 25, 0.4);
      backdrop-filter: blur(8px);
      flex-shrink: 0;
    }
    .chat-input-row {
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }
    .chat-input-row textarea {
      flex-grow: 1;
      min-width: 0;
      height: 42px;
      min-height: 42px;
      max-height: 100px;
      padding: 10px;
      font-size: 12.5px;
    }
    #send-btn {
      width: 42px;
      height: 42px;
      border-radius: 6px;
      background: var(--color-primary);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 2px 6px rgba(16, 185, 129, 0.15);
    }
    #send-btn:hover {
      background: var(--color-primary-hover);
      box-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);
    }
    .send-icon {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }
    .chat-input-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
    }
    .toggle-switch {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .toggle-switch input {
      display: none;
    }
    .slider {
      width: 30px;
      height: 16px;
      background-color: rgba(255,255,255,0.08);
      border: 1px solid var(--border-color);
      border-radius: 30px;
      position: relative;
      transition: .3s;
    }
    .slider:before {
      content: "";
      position: absolute;
      height: 10px;
      width: 10px;
      left: 2px;
      bottom: 2px;
      background-color: var(--text-secondary);
      border-radius: 50%;
      transition: .3s;
    }
    .toggle-switch input:checked + .slider {
      background-color: var(--color-primary);
    }
    .toggle-switch input:checked + .slider:before {
      transform: translateX(14px);
      background-color: #fff;
    }
    .toggle-label {
      font-size: 10.5px;
      color: var(--text-secondary);
      font-weight: 500;
    }
    .approval-card {
      border: 1px dashed var(--color-warning);
      background: rgba(245, 158, 11, 0.04);
      border-radius: 10px;
      padding: 12px;
      margin: 8px 0;
      animation: pulseBorder 1.5s infinite alternate;
      width: 100%;
    }
    .approval-card-title {
      font-size: 12.5px;
      font-weight: 700;
      color: var(--color-warning);
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .approval-card-reason {
      font-size: 11.5px;
      color: var(--text-primary);
      margin-bottom: 10px;
      line-height: 1.4;
    }
    .approval-actions {
      display: flex;
      gap: 8px;
    }
    .approval-actions button {
      padding: 6px 12px;
      font-size: 11.5px;
    }
    .approval-actions .btn-approve {
      background: var(--color-primary);
      color: #fff;
    }
    .approval-actions .btn-approve:hover {
      background: var(--color-primary-hover);
    }
    .console-drawer {
      background: #030611;
      border-top: 1px solid var(--border-color);
      position: relative;
      display: flex;
      flex-direction: column;
      transition: height 0.22s ease;
      height: 36px;
      flex-shrink: 0;
    }
    .console-drawer.expanded {
      height: 240px;
    }
    .console-header {
      padding: 8px 20px;
      background: rgba(255, 255, 255, 0.01);
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      height: 36px;
    }
    .console-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      letter-spacing: 0.025em;
    }
    .console-toggle {
      font-size: 9px;
      color: var(--text-secondary);
      font-weight: 700;
    }
    .console-body {
      flex-grow: 1;
      padding: 10px 20px;
      overflow-y: auto;
      display: none;
    }
    .console-drawer.expanded .console-body {
      display: block;
    }
    .console-content {
      font-family: var(--font-mono);
      font-size: 10.5px;
      line-height: 1.45;
      color: #0dd39e;
    }
    .console-content .log-line {
      border-bottom: 1px solid rgba(255,255,255,0.01);
      padding: 2px 0;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .console-content .log-line.ai-event {
      color: #60a5fa;
    }
    .console-content .log-line.ai-event::before {
      content: '[AI] ';
      color: #3b82f6;
      font-weight: 600;
    }
    .console-content .log-line.system-event {
      color: #f59e0b;
    }
    .console-content .log-line.system-event::before {
      content: '[SYS] ';
      color: #f59e0b;
      font-weight: 600;
    }
    .thinking-bubble {
      background: rgba(59, 130, 246, 0.08);
      border: 1px solid rgba(59, 130, 246, 0.2);
      color: #93bbfc;
      font-style: italic;
    }
    .tool-call-bubble {
      background: rgba(245, 158, 11, 0.06);
      border: 1px solid rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      font-size: 11.5px;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.35); }
      70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    @keyframes pulseBorder {
      0% { border-color: rgba(245, 158, 11, 0.3); }
      100% { border-color: rgba(245, 158, 11, 0.7); }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 900px) {
      .app-container { flex-direction: column; overflow: auto; }
      .sidebar { width: 100%; height: auto; border-right: 0; border-bottom: 1px solid var(--border-color); }
      .sidebar.collapsed { width: 100%; height: 42px; }
      .chat-workspace { height: calc(100vh - 400px); min-height: 480px; }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <aside id="setup-panel" class="sidebar">
      <div class="sidebar-header">
        <div class="brand">
          <svg class="brand-logo" viewBox="0 0 24 24">
            <path d="M12 2L2 22h20L12 2zm0 3.6L19.4 19H4.6L12 5.6zM11 16h2v2h-2zm0-6h2v4h-2z"/>
          </svg>
          <div>
            <h2>Mothership</h2>
            <div class="subtitle">Local Control Plane</div>
          </div>
        </div>
        <div class="sidebar-actions">
          <span id="beacon-pill" class="status-badge">Beacon</span>
          <button class="btn-secondary setup-toggle" onclick="toggleSetupPanel()" title="Collapse setup panel">
            <span id="setup-toggle-icon">◀</span>
          </button>
        </div>
      </div>
      <nav class="sidebar-tabs">
        <button class="tab-btn active" onclick="switchSidebarTab('outposts-tab')">🛰️ Outposts</button>
        <button class="tab-btn" onclick="switchSidebarTab('setup-tab')">⚙️ Config</button>
        <button class="tab-btn" onclick="switchSidebarTab('providers-tab')">🔑 AI Key</button>
        <button class="tab-btn" onclick="switchSidebarTab('catalog-tab')">📚 Catalog</button>
      </nav>
      <div class="sidebar-content">
        <div id="outposts-tab" class="tab-pane active">
          <div class="section-title">
            <h3>Active Outposts</h3>
            <button class="icon-btn" onclick="refresh()">🔄</button>
          </div>
          <div id="outposts-list" class="outposts-list"></div>
        </div>
        <div id="setup-tab" class="tab-pane">
          <div class="settings-card">
            <h3>Mothership Settings</h3>
            <div class="form-group">
              <label for="beacon-urls">Beacon URLs</label>
              <textarea id="beacon-urls" rows="2" placeholder="ws://127.0.0.1:8787"></textarea>
            </div>
            <div class="form-group">
              <label for="approval-mode">Approval Mode</label>
              <select id="approval-mode">
                <option value="automatic">Automatic</option>
                <option value="confirm_risky">Confirm risky</option>
                <option value="confirm_external_changes">Confirm external changes</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div class="btn-group">
              <button onclick="saveConfig()">Save Settings</button>
              <button class="btn-secondary" onclick="checkBeacon()">Check Selected</button>
            </div>
            <div id="settings-result" class="console-box" style="display:none;"></div>
          </div>
          <div class="settings-card">
            <h3>Add Outpost</h3>
            <div class="form-grid">
              <div class="form-group">
                <label for="display-name">Display Name</label>
                <input id="display-name" placeholder="marketing-site">
              </div>
              <div class="form-group">
                <label for="pairing-beacon">Pairing Beacon</label>
                <select id="pairing-beacon"></select>
              </div>
              <div class="form-group">
                <label for="install-command">Install Override</label>
                <input id="install-command" placeholder="npm install">
              </div>
              <div class="form-group">
                <label for="build-command">Build Override</label>
                <input id="build-command" placeholder="npm run build">
              </div>
              <div class="form-group">
                <label for="output-dir">Output Override</label>
                <input id="output-dir" placeholder="dist">
              </div>
              <div class="form-group">
                <label for="retain-releases">Retain Releases</label>
                <input id="retain-releases" type="number" placeholder="5" min="1">
              </div>
            </div>
            <button class="btn-block" onclick="pair()">Generate setup command</button>
            <pre id="pairing" class="console-box" style="display:none;"></pre>
          </div>

        </div>
        <div id="providers-tab" class="tab-pane">
          <div class="settings-card">
            <h3>AI Provider Setup</h3>
            <div class="form-group">
              <label for="ai-provider">Provider</label>
              <select id="ai-provider">
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </div>
            <div class="form-group">
              <label for="ai-key">API Key</label>
              <input id="ai-key" type="password" placeholder="sk-...">
            </div>
            <div class="form-group">
              <label for="ai-model">Default Model</label>
              <input id="ai-model" placeholder="gpt-4.1-mini">
            </div>
            <div class="form-group">
              <label for="ai-base-url">Base URL</label>
              <input id="ai-base-url" placeholder="https://api.openai.com/v1">
            </div>
            <div class="btn-group">
              <button onclick="saveAi()">Save Provider</button>
              <button class="btn-secondary" onclick="validateAi()">Validate Key</button>
            </div>
            <div id="ai-status" class="validation-status"></div>
          </div>
        </div>
        <div id="catalog-tab" class="tab-pane">
          <div class="settings-card">
            <h3>Mothership Plugins</h3>
            <div class="form-group">
              <label for="plugin-name">Plugin Name</label>
              <input id="plugin-name" placeholder="inspect-nginx">
            </div>
            <div class="form-group">
              <label for="plugin-description">Description</label>
              <input id="plugin-description" placeholder="Inspect local nginx status">
            </div>
            <button class="btn-block" onclick="createPlugin()">Create starter plugin</button>
            <div id="plugin-result" class="console-box" style="display:none;"></div>
            <div id="plugins" style="margin-top:12px;display:flex;flex-direction:column;gap:8px;"></div>
          </div>
          <div class="catalog-section">
            <h3>Deployment Recipes</h3>
            <div id="recipes" class="catalog-list"></div>
          </div>
          <div class="catalog-section">
            <h3>Harness Tools</h3>
            <div id="tools" class="catalog-list"></div>
          </div>
        </div>
      </div>
    </aside>
    <main class="chat-workspace">
      <header class="workspace-header">
        <div class="system-status-bar">
          <div class="status-item">
            <span class="status-dot online"></span>
            <span class="status-label">Mothership</span>
          </div>
          <div class="status-item">
            <span id="header-beacon-dot" class="status-dot"></span>
            <span id="header-beacon-text" class="status-label">Beacon</span>
          </div>
          <div class="status-item">
            <span id="header-ai-dot" class="status-dot"></span>
            <span id="header-ai-text" class="status-label">AI Operator</span>
          </div>
        </div>
        <button class="btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="clearChatHistory()">Clear Chat</button>
      </header>
      <div id="chat-messages" class="chat-messages"></div>
      <div class="suggestion-chips">
        <button class="chip" onclick="applySuggestion('Inspect the local host configurations')">🔍 Inspect Local Host</button>
        <button class="chip" onclick="applySuggestion('Recommend deployment recipes for this directory')">🚀 Recommend Recipes</button>
        <button class="chip" onclick="applySuggestion('Detect the app structure here')">🛠️ Detect Local App</button>
        <button class="chip" onclick="applySuggestion('Plan a deployment for this app')">📈 Plan Local Deploy</button>
        <button class="chip" onclick="applySuggestion('Check health of deployment endpoint')">🩺 Run Health Check</button>
      </div>
      <div class="chat-input-container">
        <div class="chat-input-row">
          <textarea id="ai-message" placeholder="Ask AI Operator to plan, inspect, or deploy (e.g. 'Plan a deployment for this repository to local host')..." onkeydown="handleChatSubmit(event)"></textarea>
          <button id="send-btn" onclick="askAi()">
            <svg class="send-icon" viewBox="0 0 24 24">
              <path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/>
            </svg>
          </button>
        </div>
        <div class="chat-input-footer">
          <label class="toggle-switch">
            <input id="ai-plugin-write" type="checkbox">
            <span class="slider"></span>
            <span class="toggle-label">Allow AI Operator to generate and install local plugins</span>
          </label>
        </div>
      </div>
      <div id="console-drawer" class="console-drawer">
        <div class="console-header" onclick="toggleConsoleDrawer()">
          <span class="console-title">Console Activity & Logs</span>
          <span id="console-toggle-icon" class="console-toggle">▲</span>
        </div>
        <div class="console-body">
          <div id="activity" class="console-content"></div>
        </div>
      </div>
    </main>
  </div>
  <script>
    let currentState = null;
    let chatMessages = [];
    let consoleLogs = [];
    let lastRenderedStateHash = '';
    let isRefreshing = false;
    let pendingRefresh = false;
    let setupPanelCollapsed = localStorage.getItem('outpost_setup_panel_collapsed') === 'true';

    // Load Chat History
    try {
      const savedChat = JSON.parse(localStorage.getItem('outpost_chat_history'));
      chatMessages = Array.isArray(savedChat) ? savedChat : [];
    } catch (e) {
      chatMessages = [];
    }

    if (!chatMessages.length) {
      chatMessages.push({
        sender: 'operator',
        text: 'Welcome to Outpost Mothership. I am your local AI deployment operator. I can help you plan deployments, inspect hosts, pair outposts, recommend recipes, and orchestrate updates.'
      });
    }

    persistChatMessages();

    function hashState(state) {
      if (!state) return '';
      try {
        return JSON.stringify({
          outposts: (state.outposts || []).map(function(outpost) {
            const report = outpost.lastStatus || {};
            return {
              peerId: outpost.peerId,
              projectName: outpost.projectName || report.projectName,
              updatedAt: outpost.updatedAt,
              online: state.beacon && state.beacon.onlinePeers ? state.beacon.onlinePeers.includes(outpost.peerId) : false,
              state: report.state,
              release: report.currentReleaseId,
              commit: report.currentCommit,
              releases: (report.releases || []).map(function(release) {
                return [release.releaseId, release.commit, release.createdAt, release.status];
              })
            };
          }),
          operations: ((state.operations && state.operations.operations) || []).slice(0, 20).map(function(operation) {
            return {
              id: operation.id,
              status: operation.status,
              approval: operation.approval && operation.approval.status,
              events: operation.events ? operation.events.length : 0,
              finishedAt: operation.finishedAt,
              error: operation.error
            };
          }),
          p: (state.plugins && state.plugins.plugins) ? state.plugins.plugins.length : 0,
          r: (state.recipes && state.recipes.recipes) ? state.recipes.recipes.length : 0,
          t: (state.tools && state.tools.tools) ? state.tools.tools.length : 0,
          beacon: state.beacon ? {
            connected: state.beacon.connected,
            peers: state.beacon.onlinePeers || [],
            commandResults: (state.beacon.commandResults || []).length,
            buildLogs: (state.beacon.buildLogs || []).length
          } : {},
          ai: state.ai ? {
            provider: state.ai.provider,
            model: state.ai.defaultModel,
            validationStatus: state.ai.validationStatus,
            lastValidatedAt: state.ai.lastValidatedAt,
            lastValidationError: state.ai.lastValidationError
          } : {},
          config: state.config ? {
            beaconUrl: state.config.beaconUrl,
            beacons: state.config.beacons,
            approvalMode: state.config.approvals && state.config.approvals.mode
          } : {}
        });
      } catch (e) {
        return '';
      }
    }

    function switchSidebarTab(tabId) {
      document.querySelectorAll('.tab-pane').forEach(function(pane) {
        pane.classList.remove('active');
      });
      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.classList.remove('active');
      });
      document.getElementById(tabId).classList.add('active');
      const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(function(btn) {
        return btn.getAttribute('onclick').includes(tabId);
      });
      if (activeBtn) activeBtn.classList.add('active');
    }

    function toggleConsoleDrawer() {
      const drawer = document.getElementById('console-drawer');
      const icon = document.getElementById('console-toggle-icon');
      if (drawer.classList.contains('expanded')) {
        drawer.classList.remove('expanded');
        icon.textContent = '▲';
      } else {
        drawer.classList.add('expanded');
        icon.textContent = '▼';
      }
    }

    function applySetupPanelState() {
      const panel = document.getElementById('setup-panel');
      const icon = document.getElementById('setup-toggle-icon');
      const button = icon ? icon.closest('button') : null;
      if (!panel) return;
      panel.classList.toggle('collapsed', setupPanelCollapsed);
      if (icon) icon.textContent = setupPanelCollapsed ? '▶' : '◀';
      if (button) {
        button.title = setupPanelCollapsed ? 'Expand setup panel' : 'Collapse setup panel';
      }
    }

    function toggleSetupPanel() {
      setupPanelCollapsed = !setupPanelCollapsed;
      localStorage.setItem('outpost_setup_panel_collapsed', setupPanelCollapsed ? 'true' : 'false');
      applySetupPanelState();
    }

    function applySuggestion(text) {
      const textarea = document.getElementById('ai-message');
      if (textarea) {
        textarea.value = text;
        textarea.focus();
      }
    }

    function handleChatSubmit(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        askAi();
      }
    }

    function clearChatHistory() {
      if (confirm('Are you sure you want to clear your chat history?')) {
        chatMessages = [{
          sender: 'operator',
          text: 'Welcome to Outpost Mothership. I am your local AI deployment operator. I can help you plan deployments, inspect hosts, pair outposts, recommend recipes, and orchestrate updates.'
        }];
        localStorage.setItem('outpost_chat_history', JSON.stringify(chatMessages));
        renderChat();
      }
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, function(char) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
      });
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(new RegExp('\\\\x60', 'g'), '&#96;');
    }

    function formatMarkdown(text) {
      if (!text) return '';
      let html = escapeHtml(text);

      // Code blocks: \`\`\`lang ... \`\`\`
      html = html.replace(/\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g, function(match, code) {
        const lines = code.trim().split('\\n');
        let lang = '';
        let codeContent = code;
        if (lines.length > 0 && /^[a-zA-Z0-9_-]+$/.test(lines[0])) {
          lang = lines[0];
          codeContent = lines.slice(1).join('\\n');
        }
        return '<pre class="code-block"><div class="code-header">' + escapeHtml(lang || 'code') + '</div><code>' + codeContent + '</code></pre>';
      });

      // Inline code: \`code\`
      html = html.replace(/\\\`([^\\\`\\n]+)\\\`/g, '<code class="inline-code">$1</code>');

      // Bold: **text**
      html = html.replace(/\\*\\*([\\s\\S]*?)\\*\\*/g, '<strong>$1</strong>');

      // Headings
      html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
      html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
      html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

      // Lists
      html = html.replace(/^\\s*[-*]\\s+(.*$)/gim, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\/li>)/g, '<ul>$1</ul>');
      html = html.replace(/<\\/ul>\\s*<ul>/g, '');

      return html.split('\\n\\n').map(function(p) {
        const trimmed = p.trim();
        if (trimmed.indexOf('<pre') === 0 || trimmed.indexOf('<h') === 0 || trimmed.indexOf('<ul') === 0) {
          return p;
        }
        return '<p>' + p.replace(/\\n/g, '<br>') + '</p>';
      }).join('');
    }

    function renderChat() {
      const container = document.getElementById('chat-messages');
      if (!container) return;

      let html = '';
      chatMessages.forEach(function(msg) {
        const senderClass = msg.sender === 'user' ? 'user' : (msg.sender === 'operator' ? 'operator' : 'system');
        const senderName = msg.sender === 'user' ? 'User' : (msg.sender === 'operator' ? 'AI Operator' : 'System');
        let bubbleClass = 'message-bubble';
        if (msg.isStreaming && msg.thinking && msg.thinking.length) {
          bubbleClass += ' thinking-bubble';
        }
        if (msg.isStreaming && msg.toolCalls && msg.toolCalls.length) {
          bubbleClass += ' tool-call-bubble';
        }
        html += '<div class="message-wrapper ' + senderClass + '">' +
          '<div class="message-sender">' + senderName + (msg.isStreaming ? ' <span style="opacity:0.6;">(thinking...)</span>' : '') + '</div>' +
          '<div class="' + bubbleClass + '">' + formatMarkdown(msg.text) + '</div>' +
        '</div>';
      });

      // Render any active operations waiting for approval in the operations list as inline cards
      if (currentState && currentState.operations && currentState.operations.operations) {
        currentState.operations.operations.forEach(function(op) {
          const isPending = op.status === 'waiting_approval' || (op.approval && op.approval.status === 'required');
          if (isPending) {
            html += '<div class="message-wrapper system">' +
              '<div class="approval-card">' +
                '<div class="approval-card-title">⚠️ Action Approval Required</div>' +
                '<div class="approval-card-reason">' +
                  'Operation <b>' + escapeHtml(op.toolName) + '</b> (' + escapeHtml(op.title) + ') requires approval.<br>' +
                  '<span style="opacity:0.75;font-size:11px;">' + escapeHtml((op.approval && op.approval.reason) || 'Approval required.') + '</span>' +
                '</div>' +
                '<div class="approval-actions">' +
                  '<button class="btn-approve" onclick="approveOperation(\\'' + escapeAttr(op.id) + '\\', this)">Approve</button>' +
                  '<button class="btn-secondary" onclick="dismissApprovalCard(this)">Dismiss</button>' +
                '</div>' +
              '</div>' +
            '</div>';
          }
        });
      }

      container.innerHTML = html;
      container.scrollTop = container.scrollHeight;
    }

    function persistChatMessages() {
      const durableMessages = chatMessages.filter(function(msg) {
        return !msg.isStreaming;
      }).slice(-50);
      localStorage.setItem('outpost_chat_history', JSON.stringify(durableMessages));
    }

    function addChatMessage(sender, text) {
      chatMessages.push({ sender: sender, text: text });
      if (chatMessages.length > 50) {
        chatMessages.shift();
      }
      persistChatMessages();
      renderChat();
    }

    async function approveOperation(opId, btnElement) {
      if (btnElement) {
        btnElement.textContent = 'Approving...';
        btnElement.disabled = true;
      }
      const op = currentState.operations.operations.find(function(item) { return item.id === opId; });
      if (!op) {
        alert("Operation not found.");
        return;
      }
      try {
        const response = await fetch('/api/operations/' + encodeURIComponent(opId) + '/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        const data = await response.json();
        if (data.error) {
          alert("Approval failed: " + data.error);
        } else {
          addChatMessage('system', 'Operation approved successfully: ' + op.title);
        }
      } catch (err) {
        alert("Error approving: " + err.message);
      } finally {
        await refresh();
      }
    }

    function dismissApprovalCard(btnElement) {
      const card = btnElement.closest('.message-wrapper.system');
      if (card) {
        card.style.display = 'none';
      }
    }

    async function refresh() {
      if (isRefreshing) {
        pendingRefresh = true;
        return;
      }
      isRefreshing = true;
      try {
        const response = await fetch('/api/state');
        currentState = await response.json();
        const [bootstrap, plugins, ai, operations, tools, recipes] = await Promise.all([
          fetch('/api/bootstrap').then(r => r.json()),
          fetch('/api/plugins').then(r => r.json()),
          fetch('/api/ai').then(r => r.json()),
          fetch('/api/operations').then(r => r.json()),
          fetch('/api/tools').then(r => r.json()),
          fetch('/api/recipes').then(r => r.json())
        ]);
        currentState.bootstrap = bootstrap;
        currentState.plugins = plugins;
        currentState.ai = ai;
        currentState.operations = operations;
        currentState.tools = tools;
        currentState.recipes = recipes;
        
        const newHash = hashState(currentState);
        if (newHash !== lastRenderedStateHash) {
          lastRenderedStateHash = newHash;
          render(currentState);
        }
      } finally {
        isRefreshing = false;
        if (pendingRefresh) {
          pendingRefresh = false;
          refresh();
        }
      }
    }

    async function pair() {
      const retainValue = document.getElementById('retain-releases').value.trim();
      const body = {
        beaconUrl: selectedBeacon('pairing-beacon'),
        displayName: document.getElementById('display-name').value.trim() || undefined,
        installCommand: document.getElementById('install-command').value.trim() || undefined,
        buildCommand: document.getElementById('build-command').value.trim() || undefined,
        outputDir: document.getElementById('output-dir').value.trim() || undefined,
        retainReleases: retainValue ? Number(retainValue) : undefined
      };
      const response = await fetch('/api/pairing-payload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      const pre = document.getElementById('pairing');
      pre.style.display = 'block';
      pre.textContent = data.error || data.command;
    }

    async function saveConfig() {
      const beaconUrls = document.getElementById('beacon-urls').value.trim();
      const response = await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ beaconUrls, approvalMode: document.getElementById('approval-mode').value }) });
      const data = await response.json();
      const res = document.getElementById('settings-result');
      res.style.display = 'block';
      res.textContent = data.error || 'Settings saved successfully.';
      await refresh();
    }

    async function checkBeacon() {
      const beaconUrl = selectedBeacon('pairing-beacon');
      const response = await fetch('/api/beacon/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ beaconUrl }) });
      const data = await response.json();
      const res = document.getElementById('settings-result');
      res.style.display = 'block';
      res.textContent = data.message || data.error;
    }



    async function maybeApprove(data, runApproved) {
      if (!data || !data.approvalRequired) return false;
      addChatMessage('system', 'Operation initiated: ' + ((data.operation && data.operation.title) || 'Action') + '. Approval is required to proceed.');
      await refresh();
      return true;
    }

    async function saveAi() {
      const body = {
        provider: document.getElementById('ai-provider').value,
        apiKey: document.getElementById('ai-key').value.trim() || undefined,
        defaultModel: document.getElementById('ai-model').value.trim() || undefined,
        baseUrl: document.getElementById('ai-base-url').value.trim() || undefined
      };
      const response = await fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      document.getElementById('ai-status').textContent = data.error || providerStatusText(data);
      await refresh();
    }

    async function validateAi() {
      const response = await fetch('/api/ai/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await response.json();
      if (await maybeApprove(data, function() {
        return fetch('/api/ai/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved: true }) });
      })) {
        await refresh();
        return;
      }
      document.getElementById('ai-status').textContent = data.error || providerStatusText(data);
      await refresh();
    }

    async function askAi() {
      const inputEl = document.getElementById('ai-message');
      const sendBtn = document.getElementById('send-btn');
      if (!inputEl) return;
      const message = inputEl.value.trim();
      if (!message) return;

      inputEl.value = '';
      if (sendBtn) sendBtn.disabled = true;

      addChatMessage('user', message);
      
      const streamingMsgId = 'streaming-' + Date.now();
      chatMessages.push({
        id: streamingMsgId,
        sender: 'operator',
        text: '',
        isStreaming: true,
        thinking: []
      });
      renderChat();

      try {
        let fullMessage = '';
        let toolCalls = 0;
        
        // Use POST via fetch with ReadableStream for SSE
        const response = await fetch('/api/ai/chat/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: message,
            allowPluginWrite: document.getElementById('ai-plugin-write').checked
          })
        });
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let toolEvents = [];
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6));
                handleStreamEvent(event, streamingMsgId);
                if (event.type === 'message') {
                  fullMessage = event.content;
                }
                if (event.type === 'tool_call') {
                  toolCalls++;
                  toolEvents.push({ name: event.toolName, input: event.input, status: 'running' });
                }
                if (event.type === 'tool_result') {
                  const pending = toolEvents.slice().reverse().find(function(item) {
                    return item.name === event.toolName && item.status === 'running';
                  });
                  if (pending) {
                    pending.status = 'completed';
                    pending.result = event.result;
                  } else {
                    toolEvents.push({ name: event.toolName, result: event.result, status: 'completed' });
                  }
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        }
        
        // Remove streaming message and add final
        chatMessages = chatMessages.filter(function(msg) {
          return msg.id !== streamingMsgId;
        });
        
        if (fullMessage) {
          if (message.toLowerCase() === '/reset') {
            chatMessages = [];
            localStorage.removeItem('outpost_chat_history');
          }
          let reply = fullMessage;
          addChatMessage('operator', reply);
        }
      } catch (err) {
        chatMessages = chatMessages.filter(function(msg) {
          return msg.id !== streamingMsgId;
        });
        addChatMessage('operator', 'Communication failure: ' + err.message);
      } finally {
        if (sendBtn) sendBtn.disabled = false;
        await refresh();
      }
    }
    
    function handleStreamEvent(event, msgId) {
      if (event.type === 'warning') {
        addConsoleLog(event.message, 'system');
        addChatMessage('system', event.message);
        return;
      }

      const msg = chatMessages.find(function(m) { return m.id === msgId; });
      if (!msg) return;
      
      if (event.type === 'thinking') {
        if (!msg.thinking) msg.thinking = [];
        msg.thinking.push(event.content);
        msg.text = formatThinkingAndMessage(msg.thinking, msg.toolCalls);
        renderChat();
      } else if (event.type === 'tool_call') {
        if (!msg.toolCalls) msg.toolCalls = [];
        msg.toolCalls.push({ name: event.toolName, input: event.input, status: 'running' });
        msg.text = formatThinkingAndMessage(msg.thinking, msg.toolCalls);
        renderChat();
        addConsoleLog('AI invoking tool: ' + event.toolName + ' ' + compactJson(event.input, 800), 'ai');
      } else if (event.type === 'tool_result') {
        if (!msg.toolCalls) msg.toolCalls = [];
        const pending = msg.toolCalls.slice().reverse().find(function(item) {
          return item.name === event.toolName && item.status === 'running';
        });
        if (pending) {
          pending.status = 'completed';
          pending.result = event.result;
        } else {
          msg.toolCalls.push({ name: event.toolName, result: event.result, status: 'completed' });
        }
        msg.text = formatThinkingAndMessage(msg.thinking, msg.toolCalls);
        renderChat();
        addConsoleLog('Tool completed: ' + event.toolName + ' ' + compactJson(event.result, 1200), 'ai');
      } else if (event.type === 'error') {
        msg.text = 'Error: ' + event.message;
        renderChat();
      }
    }
    
    function formatThinkingAndMessage(thinking, toolCalls) {
      let parts = [];
      if (thinking && thinking.length) {
        parts.push('*Thinking:* ' + thinking[thinking.length - 1]);
      }
      if (toolCalls && toolCalls.length) {
        parts.push('Working with deployment tools...');
      }
      return parts.join('\\n\\n');
    }

    function compactJson(value, maxLength) {
      let text;
      try {
        text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      } catch (e) {
        text = String(value);
      }
      if (text.length > maxLength) {
        return text.slice(0, maxLength - 32) + '\\n... truncated ...';
      }
      return text;
    }

    function addConsoleLog(text, source) {
      const container = document.getElementById('activity');
      consoleLogs.unshift({
        at: new Date().toLocaleTimeString(),
        text: text,
        source: source === 'ai' ? 'ai' : 'system'
      });
      consoleLogs = consoleLogs.slice(0, 100);
      if (!container) return;
      const line = document.createElement('div');
      line.className = 'log-line ' + (source === 'ai' ? 'ai-event' : 'system-event');
      line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
      container.insertBefore(line, container.firstChild);
      // Keep only last 100 lines
      while (container.children.length > 100) {
        container.removeChild(container.lastChild);
      }
    }

    async function createPlugin() {
      const name = document.getElementById('plugin-name').value.trim();
      const desc = document.getElementById('plugin-description').value.trim();
      const draft = await (await fetch('/api/ai/plugin-draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json();
      const response = await fetch('/api/plugins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        name: name,
        description: desc,
        code: draft.code
      }) });
      const data = await response.json();
      const res = document.getElementById('plugin-result');
      res.style.display = 'block';
      res.textContent = data.error || ('Plugin instantiated successfully: ' + data.id);
      await refresh();
    }

    async function runPluginById(pluginId) {
      const response = await fetch('/api/plugins/' + encodeURIComponent(pluginId) + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: currentState }) });
      const data = await response.json();
      const res = document.getElementById('plugin-result');
      res.style.display = 'block';
      res.textContent = data.error || (data.stdout || data.stderr || JSON.stringify(data, null, 2));
    }

    async function sendCommand(peerId, command) {
      const response = await fetch('/api/outposts/' + encodeURIComponent(peerId) + '/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
      const data = await response.json();
      if (await maybeApprove(data, function() {
        return fetch('/api/outposts/' + encodeURIComponent(peerId) + '/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({}, command, { approved: true })) });
      })) {
        await refresh();
        return;
      }
      if (data.error) {
        addChatMessage('system', 'Outpost command failed: ' + data.error);
        return;
      }
      await refresh();
    }

    function render(state) {
      const beaconUrls = (state.config.beacons || [{ url: state.config.beaconUrl || '' }]).map(function(beacon) { return beacon.url; }).filter(Boolean);
      document.getElementById('beacon-urls').value = beaconUrls.join('\\n');
      renderBeaconSelect('pairing-beacon', beaconUrls);

      document.getElementById('approval-mode').value = ((state.config.approvals || {}).mode) || 'automatic';
      
      const pill = document.getElementById('beacon-pill');
      if (pill) {
        pill.textContent = state.beacon.connected ? 'Relay Online' : 'Relay Offline';
        pill.className = state.beacon.connected ? 'status-badge online' : 'status-badge offline';
      }

      document.getElementById('ai-provider').value = state.ai.provider || 'openai';
      document.getElementById('ai-model').value = state.ai.defaultModel || '';
      document.getElementById('ai-base-url').value = state.ai.baseUrl || '';
      document.getElementById('ai-status').textContent = providerStatusText(state.ai);
      
      updateHeaderIndicators(state);

      renderPlugins(state);
      renderOutposts(state);
      renderActivity(state);
      renderChat();
      renderRecipes(state);
      renderTools(state);
    }

    function updateHeaderIndicators(state) {
      const beaconDot = document.getElementById('header-beacon-dot');
      const beaconText = document.getElementById('header-beacon-text');
      if (beaconDot && beaconText) {
        if (state.beacon.connected) {
          beaconDot.className = 'status-dot online';
          beaconText.textContent = 'Relay Online';
        } else {
          beaconDot.className = 'status-dot offline';
          beaconText.textContent = 'Relay Offline';
        }
      }
      
      const aiDot = document.getElementById('header-ai-dot');
      const aiText = document.getElementById('header-ai-text');
      if (aiDot && aiText) {
        if (state.ai.validationStatus === 'valid') {
          aiDot.className = 'status-dot online';
          aiText.textContent = 'AI Operator Ready';
        } else if (state.ai.validationStatus === 'unvalidated') {
          aiDot.className = 'status-dot warning';
          aiText.textContent = 'Key Unvalidated';
        } else {
          aiDot.className = 'status-dot offline';
          aiText.textContent = 'AI Config Missing';
        }
      }
    }

    function renderBeaconSelect(id, urls) {
      const select = document.getElementById(id);
      const current = select.value;
      select.innerHTML = urls.map(function(url) { return '<option value="' + escapeAttr(url) + '">' + escapeHtml(url) + '</option>'; }).join('');
      if (urls.includes(current)) select.value = current;
    }

    function selectedBeacon(id) {
      const select = document.getElementById(id);
      return select.value || ((currentState.config.beacons || [])[0] || {}).url || currentState.config.beaconUrl;
    }

    function providerStatusText(ai) {
      const provider = ai.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI';
      if (ai.validationStatus === 'valid') return provider + ' validated successfully.';
      if (ai.validationStatus === 'invalid') return provider + ' invalid key' + (ai.lastValidationError ? ': ' + ai.lastValidationError : '');
      if (ai.validationStatus === 'unvalidated') return provider + ' key saved. Validation required.';
      return provider + ' API key config required.';
    }



    function renderPlugins(state) {
      const plugins = (state.plugins && state.plugins.plugins) || [];
      const container = document.getElementById('plugins');
      if (!container) return;
      if (!plugins.length) {
        container.innerHTML = '<p class="muted" style="font-size:11px;">No local plugins yet.</p>';
        return;
      }
      container.innerHTML = plugins.map(function(plugin) {
        return '<div class="catalog-item">' +
          '<div class="catalog-item-info">' +
            '<h4>' + escapeHtml(plugin.name) + '</h4>' +
            '<p>' + escapeHtml(plugin.description) + '</p>' +
          '</div>' +
          '<button class="btn-secondary" style="padding:4px 8px;font-size:11px;" data-plugin="' + escapeAttr(plugin.id) + '">Run</button>' +
        '</div>';
      }).join('');
    }

    function renderOutposts(state) {
      const container = document.getElementById('outposts-list');
      if (!container) return;
      if (!state.outposts.length) {
        container.innerHTML = '<p class="muted" style="text-align:center;padding:20px 0;font-size:12px;">No Outposts paired yet.</p>';
        return;
      }
      container.innerHTML = state.outposts.map(function(outpost) {
        const report = outpost.lastStatus || {};
        const online = state.beacon.onlinePeers.includes(outpost.peerId);
        const releases = report.releases || [];
        
        const outpostState = report.state || 'unknown';
        const currentRelease = report.currentReleaseId || 'none';
        const currentBranch = report.currentBranch || 'unknown';
        const currentCommit = report.currentCommit ? report.currentCommit.slice(0, 7) : 'unknown';
        
        let releasesHtml = '<p class="muted" style="padding:4px;font-size:10px;">No releases yet.</p>';
        if (releases.length) {
          releasesHtml = releases.map(function(release) {
            return '<div class="release-row">' +
              '<div class="release-info">' +
                '<b>' + escapeHtml(release.releaseId) + '</b>' +
                '<div>' + escapeHtml(release.commit.slice(0, 7)) + ' - ' + escapeHtml(release.createdAt) + '</div>' +
              '</div>' +
              '<button class="btn-secondary" data-peer="' + escapeAttr(outpost.peerId) + '" data-command="rollback" data-release="' + escapeAttr(release.releaseId) + '">Rollback</button>' +
            '</div>';
          }).join('');
        }
        
        return '<div class="outpost-card">' +
          '<div class="outpost-card-header">' +
            '<div class="outpost-name">' +
              '<h4>' + escapeHtml(outpost.projectName || report.projectName || outpost.peerId) + '</h4>' +
              '<div class="host-label">' + escapeHtml(outpost.hostLabel || report.hostLabel || outpost.peerId) + '</div>' +
            '</div>' +
            '<span class="status-badge ' + (online ? 'online' : 'offline') + '">' + (online ? 'online' : 'offline') + '</span>' +
          '</div>' +
          '<div class="outpost-metrics">' +
            '<div class="metric-item"><span>State:</span> <b>' + escapeHtml(outpostState) + '</b></div>' +
            '<div class="metric-item"><span>Release:</span> <b>' + escapeHtml(currentRelease) + '</b></div>' +
            '<div class="metric-item"><span>Branch:</span> <b>' + escapeHtml(currentBranch) + '</b></div>' +
            '<div class="metric-item"><span>Commit:</span> <b>' + escapeHtml(currentCommit) + '</b></div>' +
          '</div>' +
          '<div class="outpost-actions">' +
            '<button class="btn-deploy" data-peer="' + escapeAttr(outpost.peerId) + '" data-command="deploy"' + (String(outpost.peerId).startsWith('pending:') ? ' disabled' : '') + '>Deploy</button>' +
            '<details class="actions-dropdown">' +
              '<summary>Actions ▾</summary>' +
              '<div class="dropdown-menu">' +
                '<button class="dropdown-item" data-peer="' + escapeAttr(outpost.peerId) + '" data-command="apply-static"' + (String(outpost.peerId).startsWith('pending:') ? ' disabled' : '') + '>Apply Static</button>' +
                '<button class="dropdown-item" data-peer="' + escapeAttr(outpost.peerId) + '" data-command="apply-node"' + (String(outpost.peerId).startsWith('pending:') ? ' disabled' : '') + '>Apply Node</button>' +
                '<button class="dropdown-item" data-peer="' + escapeAttr(outpost.peerId) + '" data-command="apply-docker"' + (String(outpost.peerId).startsWith('pending:') ? ' disabled' : '') + '>Apply Docker</button>' +
                '<button class="dropdown-item" data-peer="' + escapeAttr(outpost.peerId) + '" data-command="doctor"' + (String(outpost.peerId).startsWith('pending:') ? ' disabled' : '') + '>Doctor Check</button>' +
                '<button class="dropdown-item" data-peer="' + escapeAttr(outpost.peerId) + '" data-command="detect-app"' + (String(outpost.peerId).startsWith('pending:') ? ' disabled' : '') + '>Detect App</button>' +
                '<button class="dropdown-item" data-peer="' + escapeAttr(outpost.peerId) + '" data-command="health"' + (String(outpost.peerId).startsWith('pending:') ? ' disabled' : '') + '>Health Check</button>' +
              '</div>' +
            '</details>' +
          '</div>' +
          '<details class="release-history-details">' +
            '<summary>Release History (' + releases.length + ')</summary>' +
            '<div class="releases-container">' + releasesHtml + '</div>' +
          '</details>' +
        '</div>';
      }).join('');
    }

    function renderActivity(state) {
      const results = state.beacon.commandResults || [];
      const logs = state.beacon.buildLogs || [];
      const operations = (state.operations && state.operations.operations) || [];
      const container = document.getElementById('activity');
      if (!container) return;
      if (!results.length && !logs.length && !operations.length && !consoleLogs.length) {
        container.innerHTML = '<div class="log-line text-muted">No system activity logged yet.</div>';
        return;
      }
      
      container.innerHTML = consoleLogs.slice(0, 40).map(function(item) {
        const sourceClass = item.source === 'ai' ? 'ai-event' : 'system-event';
        return '<div class="log-line ' + sourceClass + '">[' + escapeHtml(item.at) + '] ' + escapeHtml(item.text) + '</div>';
      }).join('') + operations.slice(0, 8).map(function(operation) {
        const isPending = operation.status === 'waiting_approval' || (operation.approval && operation.approval.status === 'required');
        const approval = isPending ? ' <button class="btn-secondary approve-btn" data-op-id="' + escapeAttr(operation.id) + '" style="margin-left:8px;padding:1px 6px;font-size:10px;">Approve</button>' : '';
        const sourceClass = operation.source === 'ai' ? 'ai-event' : (operation.source === 'user' ? 'system-event' : '');
        return '<div class="log-line ' + sourceClass + '">[' + escapeHtml(operation.status) + '] ' + escapeHtml(operation.toolName) + ' - ' + escapeHtml(operation.title) + approval + '</div>';
      }).join('') + results.slice(0, 8).map(function(item) {
        return '<div class="log-line">[' + escapeHtml(item.receivedAt) + '] ' + escapeHtml(item.peerId) + ' ' + escapeHtml(item.result.commandType) + ' ' + (item.result.ok ? 'ok' : 'failed') + (item.result.message ? ' - ' + escapeHtml(item.result.message) : '') + '</div>';
      }).join('') + logs.slice(-40).map(function(item) {
        return '<div class="log-line">[' + escapeHtml(item.event.stream) + '] ' + escapeHtml(item.event.line) + '</div>';
      }).join('');
    }

    function renderRecipes(state) {
      const recipes = (state.recipes && state.recipes.recipes) || [];
      const container = document.getElementById('recipes');
      if (!container) return;
      if (!recipes.length) {
        container.innerHTML = '<div class="log-line text-muted">No recipes found.</div>';
        return;
      }
      container.innerHTML = recipes.map(function(recipe) {
        return '<div class="catalog-item">' +
          '<div class="catalog-item-info">' +
            '<h4>' + escapeHtml(recipe.name) + '</h4>' +
            '<p>' + escapeHtml(recipe.id) + ' | ' + escapeHtml(recipe.deployStrategy) + '</p>' +
          '</div>' +
          '<span class="catalog-badge">' + escapeHtml(recipe.maturity) + '</span>' +
        '</div>';
      }).join('');
    }

    function renderTools(state) {
      const tools = (state.tools && state.tools.tools) || [];
      const container = document.getElementById('tools');
      if (!container) return;
      if (!tools.length) {
        container.innerHTML = '<div class="log-line text-muted">No tools registered.</div>';
        return;
      }
      container.innerHTML = tools.map(function(tool) {
        return '<div class="catalog-item">' +
          '<div class="catalog-item-info">' +
            '<h4>' + escapeHtml(tool.name) + '</h4>' +
            '<p style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(tool.description) + '</p>' +
          '</div>' +
          '<span class="catalog-badge">' + escapeHtml(tool.authorityLevel) + '</span>' +
        '</div>';
      }).join('');
    }

    // Attach listeners
    document.getElementById('outposts-list').addEventListener('click', function(event) {
      const button = event.target.closest('button[data-command]');
      if (!button) return;
      
      const details = event.target.closest('details.actions-dropdown');
      if (details) {
        details.removeAttribute('open');
      }

      const peerId = button.dataset.peer;
      const cmd = button.dataset.command;

      if (cmd === 'deploy') sendCommand(peerId, { type: 'DEPLOY' });
      if (cmd === 'apply-static') sendCommand(peerId, { type: 'APPLY_RECIPE', recipeId: 'static-vite', approvedParameters: {} });
      if (cmd === 'apply-node') {
        const port = window.prompt("Enter port (default 3000):", "3000");
        if (port === null) return;
        const startCommand = window.prompt("Enter start command (default 'npm start'):", "npm start");
        if (startCommand === null) return;
        const healthUrl = window.prompt("Enter health check URL (default 'http://localhost:3000/health'):", "http://localhost:3000/health");
        if (healthUrl === null) return;

        sendCommand(peerId, {
          type: 'APPLY_RECIPE',
          recipeId: 'node-service',
          approvedParameters: {
            port: port ? Number(port) : undefined,
            startCommand: startCommand || undefined,
            healthUrl: healthUrl || undefined
          }
        });
      }
      if (cmd === 'apply-docker') {
        const port = window.prompt("Enter port (default 8080):", "8080");
        if (port === null) return;
        const healthUrl = window.prompt("Enter health check URL (default 'http://localhost:8080/health'):", "http://localhost:8080/health");
        if (healthUrl === null) return;

        sendCommand(peerId, {
          type: 'APPLY_RECIPE',
          recipeId: 'docker-compose',
          approvedParameters: {
            port: port ? Number(port) : undefined,
            healthUrl: healthUrl || undefined
          }
        });
      }
      if (cmd === 'doctor') sendCommand(peerId, { type: 'DOCTOR' });
      if (cmd === 'detect-app') sendCommand(peerId, { type: 'DETECT_APP' });
      if (cmd === 'health') {
        const healthUrl = window.prompt("Enter health check URL:", "http://localhost:3000/health");
        if (healthUrl === null) return;
        sendCommand(peerId, { type: 'RUN_HEALTH_CHECK', url: healthUrl.trim() || undefined });
      }
      if (cmd === 'rollback') sendCommand(peerId, { type: 'ROLLBACK', releaseId: button.dataset.release });
    });

    document.getElementById('plugins').addEventListener('click', function(event) {
      const button = event.target.closest('button[data-plugin]');
      if (!button) return;
      runPluginById(button.dataset.plugin);
    });

    document.getElementById('activity').addEventListener('click', async function(event) {
      const button = event.target.closest('.approve-btn');
      if (!button) return;
      const opId = button.dataset.opId;
      await approveOperation(opId, button);
    });

    // Boot
    applySetupPanelState();
    renderChat();
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
