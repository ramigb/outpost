/**
 * @module @outpost/mothership/ai
 *
 * AI provider management and agent orchestration for Mothership.
 *
 * Handles OpenAI (via Agents SDK) and OpenRouter providers, configuration
 * persistence, validation, streamed and non-streamed agent execution, and
 * tool dispatch through the Mothership tool catalog.
 */

import { readFile } from "node:fs/promises";
import { parseOutpostCommand } from "@outpost/protocol";
import {
  listDeploymentRecipes,
  pathExists,
  recommendDeploymentRecipes,
  writeJsonFile
} from "@outpost/shared";
import { listBootstrapOperations, startBootstrap, type BootstrapRequest } from "./bootstrap.js";
import {
  AgentToolQuotaExceededError,
  appendAgentMemory,
  buildAgentMemoryBootstrap,
  getAgentToolQuotaSnapshot,
  isResetCommand,
  resetAgentMemory,
  shouldWarnAgentToolQuota,
  toolQuotaWarningMessage,
  type TokenUsage
} from "./memory.js";
import { listPlugins, pluginTemplate, upsertPlugin } from "./plugins.js";
import {
  createLocalProvisioningPlan,
  detectLocalApp,
  inspectLocalHost,
  inspectSshHost,
  runHttpHealthCheck,
  runSshCommand
} from "./provisioning.js";
import {
  defaultAiConfig,
  createPairingCommand,
  loadMothershipState,
  mothershipPaths,
  normalizeAiConfig,
  saveMothershipConfig,
  type MothershipAiConfig
} from "./state.js";
import { executeTool, listTools, type ToolRunContext } from "./tools.js";
import {
  buildOutpostInventory,
  toolNameForOutpostCommand,
  type AiOutpostRuntime
} from "./outposts.js";
import OpenAI from "openai";
import { OpenRouter } from "@openrouter/sdk";
import type { AgentStreamEvent } from "./agent.js";

/** Maximum tool-call turns allowed for OpenRouter agent sessions. */
const MAX_OPENROUTER_TOOL_TURNS = 500;

/** Re-export of agent stream event types. */
export type StreamEvent = AgentStreamEvent;

/** Shape of persisted AI secrets file. */
type AiSecrets = {
  apiKeys?: Partial<Record<MothershipAiConfig["provider"], string>>;
  apiKey?: string;
};

/**
 * Saves or updates the AI provider configuration.
 *
 * @param input - New settings (API key, provider, base URL, model).
 * @returns The persisted, normalised AI config.
 */
export async function saveAiConfig(input: {
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
  defaultModel?: string;
}): Promise<MothershipAiConfig> {
  const state = await loadMothershipState();
  const provider = input.provider === "openrouter" ? "openrouter" : "openai";
  const current =
    state.config.ai?.provider === provider ? state.config.ai : defaultAiConfig(provider);
  const existingSecrets = await readAiSecrets();
  const activeProvider = state.config.ai?.provider ?? "openai";
  const existingApiKey =
    existingSecrets.apiKeys?.[provider] ??
    (provider === activeProvider ? existingSecrets.apiKey : undefined);
  const next = normalizeAiConfig({
    ...current,
    provider,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    hasApiKey: Boolean(input.apiKey || current.hasApiKey || existingApiKey),
    validationStatus: input.apiKey ? "unvalidated" : current.validationStatus,
    lastValidationError: input.apiKey ? undefined : current.lastValidationError
  });
  await saveMothershipConfig({ ...state.config, ai: next });
  if (input.apiKey) {
    await writeJsonFile(
      mothershipPaths().aiSecrets,
      {
        apiKeys: { ...existingSecrets.apiKeys, [provider]: input.apiKey },
        apiKey: input.apiKey
      },
      0o600
    );
  }
  return next;
}

/**
 * Returns the current normalised AI configuration.
 */
export async function getAiStatus(): Promise<MothershipAiConfig> {
  const state = await loadMothershipState();
  return normalizeAiConfig(state.config.ai);
}

/**
 * Validates the configured AI provider by listing models.
 *
 * @returns Updated AI config with `validationStatus` set to `valid` or `invalid`.
 */
export async function validateAiProvider(): Promise<MothershipAiConfig> {
  const state = await loadMothershipState();
  const current = normalizeAiConfig(state.config.ai);
  if (!current.hasApiKey) {
    const next = {
      ...current,
      validationStatus: "missing_key" as const,
      lastValidationError: "API key is missing"
    };
    await saveMothershipConfig({ ...state.config, ai: next });
    return next;
  }
  try {
    const apiKey = await readApiKeyForProvider(current.provider);
    if (current.provider === "openrouter") {
      const client = new OpenRouter({
        apiKey,
        serverURL: current.baseUrl || undefined
      });
      await client.models.list();
    } else {
      const client = new OpenAI({
        apiKey,
        baseURL: current.baseUrl || undefined
      });
      await client.models.list();
    }
    const next = {
      ...current,
      validationStatus: "valid" as const,
      lastValidatedAt: new Date().toISOString(),
      lastValidationError: undefined
    };
    await saveMothershipConfig({ ...state.config, ai: next });
    return next;
  } catch (error) {
    const next = {
      ...current,
      validationStatus: "invalid" as const,
      lastValidatedAt: new Date().toISOString(),
      lastValidationError: error instanceof Error ? error.message : String(error)
    };
    await saveMothershipConfig({ ...state.config, ai: next });
    return next;
  }
}

/**
 * Throws when no validated AI provider is configured.
 *
 * @returns The valid AI config.
 * @throws Error when the provider is missing or not validated.
 */
export async function assertHarnessProviderReady(): Promise<MothershipAiConfig> {
  const status = await getAiStatus();
  if (status.validationStatus !== "valid") {
    throw new Error(
      `Configure and validate an AI provider before running deployment harness operations. Current status: ${status.validationStatus}.`
    );
  }
  return status;
}

/**
 * Sends a user message to the AI agent and returns its response.
 *
 * @param input - Message text and optional runtime handles.
 * @returns Assistant message and optional plugin creation info.
 */
export async function askAiAgent(input: {
  message: string;
  allowPluginWrite?: boolean;
  outposts?: AiOutpostRuntime;
}): Promise<{ message: string; pluginCreated?: string; usage?: TokenUsage }> {
  if (isResetCommand(input.message)) {
    await resetAgentMemory();
    return {
      message:
        "Session memory reset. Future requests will start with an empty Mothership memory context."
    };
  }
  const status = await assertHarnessProviderReady();
  const memory = await buildAgentMemoryBootstrap(status.defaultModel, input.message);
  let result: { message: string; pluginCreated?: string; usage?: TokenUsage; toolCalls?: number };
  if (status.provider === "openai") {
    const { runDeploymentAgent } = await import("./agent.js");
    result = await runDeploymentAgent({
      message: input.message,
      memoryContext: memory.context,
      outposts: input.outposts
    });
  } else {
    result = await runOpenRouterAgent({ ...input, memoryContext: memory.context });
  }
  await appendAgentMemory({
    userMessage: input.message,
    assistantMessage: result.message,
    toolCalls:
      "toolCalls" in result && typeof result.toolCalls === "number" ? result.toolCalls : undefined,
    usage: memory.usage,
    actualUsage: result.usage
  });
  return result;
}

/**
 * Sends a user message to the AI agent and yields streamed events.
 *
 * @param input - Message text and optional runtime handles.
 * @yields {@link StreamEvent} objects (thinking, tool_call, tool_result, message, done, error).
 */
export async function* askAiAgentStreamed(input: {
  message: string;
  allowPluginWrite?: boolean;
  outposts?: AiOutpostRuntime;
}): AsyncGenerator<StreamEvent, { message: string; pluginCreated?: string }, unknown> {
  if (isResetCommand(input.message)) {
    await resetAgentMemory();
    yield {
      type: "message",
      content:
        "Session memory reset. Future requests will start with an empty Mothership memory context."
    };
    yield { type: "done" };
    return {
      message:
        "Session memory reset. Future requests will start with an empty Mothership memory context."
    };
  }
  const status = await assertHarnessProviderReady();
  const memory = await buildAgentMemoryBootstrap(status.defaultModel, input.message);
  if (status.provider === "openai") {
    const { runDeploymentAgentStreamed } = await import("./agent.js");
    const stream = runDeploymentAgentStreamed({
      message: input.message,
      memoryContext: memory.context,
      outposts: input.outposts
    });
    let result:
      | { message: string; pluginCreated?: string; toolCalls?: number; usage?: TokenUsage }
      | undefined;
    let toolCalls = 0;
    let quotaWarningSent = false;
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const step = await iterator.next();
      if (step.done) {
        result = step.value ? { ...step.value, usage: step.value.usage } : result;
        break;
      }
      const event = step.value;
      yield event;
      if (event.type === "tool_call") toolCalls += 1;
      if (event.type === "tool_result" && !quotaWarningSent) {
        const warning = await agentToolQuotaWarningEvent();
        if (warning) {
          quotaWarningSent = true;
          yield warning;
        }
      }
      if (event.type === "message") result = { message: event.content, toolCalls };
    }
    await appendAgentMemory({
      userMessage: input.message,
      assistantMessage: result?.message ?? "",
      toolCalls: result?.toolCalls ?? toolCalls,
      usage: memory.usage,
      actualUsage: result?.usage
    });
    return result ?? { message: "" };
  }

  const stream = runOpenRouterAgentStreamed({ ...input, memoryContext: memory.context });
  let result:
    | { message: string; pluginCreated?: string; toolCalls?: number; usage?: TokenUsage }
    | undefined;
  let toolCalls = 0;
  let quotaWarningSent = false;
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    const step = await iterator.next();
    if (step.done) {
      result = step.value ? { ...step.value, usage: step.value.usage } : result;
      break;
    }
    const event = step.value;
    yield event;
    if (event.type === "tool_call") toolCalls += 1;
    if (event.type === "tool_result" && !quotaWarningSent) {
      const warning = await agentToolQuotaWarningEvent();
      if (warning) {
        quotaWarningSent = true;
        yield warning;
      }
    }
    if (event.type === "message") result = { message: event.content, toolCalls };
  }
  await appendAgentMemory({
    userMessage: input.message,
    assistantMessage: result?.message ?? "",
    toolCalls: result?.toolCalls ?? toolCalls,
    usage: memory.usage,
    actualUsage: result?.usage
  });
  return result ?? { message: "" };
}

// --- OpenRouter agent implementation (private) ---

type OpenRouterAgentInput = {
  message: string;
  allowPluginWrite?: boolean;
  memoryContext: string;
  outposts?: AiOutpostRuntime;
};

async function runOpenRouterAgent(
  input: OpenRouterAgentInput
): Promise<{ message: string; pluginCreated?: string; usage?: TokenUsage }> {
  let result: { message: string; pluginCreated?: string; usage?: TokenUsage } | undefined;
  const stream = runOpenRouterAgentStreamed(input);
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    const step = await iterator.next();
    if (step.done) {
      result = step.value ? { ...step.value, usage: step.value.usage } : result;
      break;
    }
    if (step.value.type === "message") {
      result = { message: step.value.content };
    }
  }
  return result ?? { message: "" };
}

async function* runOpenRouterAgentStreamed(
  input: OpenRouterAgentInput
): AsyncGenerator<
  StreamEvent,
  { message: string; pluginCreated?: string; toolCalls: number; usage?: TokenUsage },
  unknown
> {
  yield { type: "thinking", content: "Processing request via OpenRouter with Mothership tools..." };
  const status = await getAiStatus();
  const apiKey = await readApiKeyForProvider(status.provider);
  const plugins = await listPlugins();
  const operations = await listBootstrapOperations();
  const outposts = await currentOutpostInventory(input.outposts);
  const { definitions, handlers } = openRouterToolKit(input.outposts);
  const system = [
    "You are the local Outpost Mothership AI agent.",
    "Your domain is deployment and operations for apps on user-owned infrastructure.",
    "You can inspect remote hosts via SSH, execute commands on them to clone git repositories or check configurations, and bootstrap target VPS environments.",
    "You have function tools mapped to real local Mothership capabilities. Call them for factual inspection before answering.",
    "For SSH questions about OS, runtimes, ports, or RAM, call host_inspect_ssh before answering.",
    "You do not act as a general coding assistant and you do not invent hidden capabilities.",
    "Beacon strict mode never permits arbitrary shell commands.",
    "If a needed deployment tool is unavailable, say which capability is missing.",
    "For questions about paired or connected Outposts, call outposts_list before answering.",
    "Use outpost_send_command for typed Beacon/Outpost operations such as GET_STATE, PING, DOCTOR, DEPLOY, ROLLBACK, DETECT_APP, RUN_HEALTH_CHECK, and APPLY_RECIPE.",
    "Use outpost_create_pairing to generate setup commands for adding or configuring Outposts.",
    input.memoryContext,
    input.allowPluginWrite
      ? "If you output a fenced code block marked mothership-plugin, it may be installed locally."
      : "Do not create files unless explicitly allowed."
  ].join("\n");
  const client = new OpenRouter({
    apiKey,
    serverURL: status.baseUrl || undefined,
    httpReferer: "https://github.com/acme/outpost",
    appTitle: "Outpost Mothership"
  });

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify(
        {
          message: input.message,
          plugins,
          availableMothershipTools: listTools(),
          recentBootstrapOperations: operations.slice(0, 5),
          outposts
        },
        null,
        2
      )
    }
  ];

  let message = "";
  let actualUsage: TokenUsage = {};
  let toolCallCount = 0;
  for (let turn = 0; turn < MAX_OPENROUTER_TOOL_TURNS; turn += 1) {
    const completion = await client.chat.send({
      chatRequest: {
        model: status.defaultModel,
        messages: messages as never,
        tools: definitions as never,
        toolChoice: "auto",
        parallelToolCalls: false
      }
    });
    actualUsage = addUsage(actualUsage, openRouterUsageSnapshot(completion.usage));
    const assistant = completion.choices?.[0]?.message;
    const toolCalls = assistant?.toolCalls ?? [];
    messages.push({
      role: "assistant",
      content: assistant?.content ?? "",
      toolCalls
    });

    if (toolCalls.length === 0) {
      message = contentToString(assistant?.content);
      break;
    }

    for (const toolCall of toolCalls) {
      const name = toolCall.function.name;
      const rawArguments = toolCall.function.arguments || "{}";
      const parsedArguments = parseToolArguments(rawArguments);
      toolCallCount += 1;
      yield { type: "tool_call", toolName: name, input: parsedArguments };
      const handler = handlers[name];
      let result: unknown;
      try {
        result = handler
          ? await handler(parsedArguments)
          : { error: `Unknown Mothership tool: ${name}` };
      } catch (error) {
        if (error instanceof AgentToolQuotaExceededError) {
          throw error;
        }
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      yield { type: "tool_result", toolName: name, result };
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify(result, null, 2)
      });
    }
  }

  if (!message) {
    message = "I ran out of tool turns before I could produce a final answer.";
  }
  const pluginCode = input.allowPluginWrite ? extractPluginCode(message) : undefined;
  if (pluginCode) {
    const plugin = await upsertPlugin({
      name: pluginNameFromPrompt(input.message),
      description: "Created by the local Mothership AI agent",
      code: pluginCode
    });
    yield { type: "message", content: message };
    yield { type: "done" };
    return { message, pluginCreated: plugin.id, toolCalls: toolCallCount, usage: actualUsage };
  }
  yield { type: "message", content: message };
  yield { type: "done" };
  return { message, toolCalls: toolCallCount, usage: actualUsage };
}

async function agentToolQuotaWarningEvent(): Promise<StreamEvent | undefined> {
  const snapshot = await getAgentToolQuotaSnapshot();
  if (!shouldWarnAgentToolQuota(snapshot)) {
    return undefined;
  }
  return {
    type: "warning",
    message: toolQuotaWarningMessage(snapshot),
    used: snapshot.used,
    limit: snapshot.limit,
    resetAt: snapshot.resetAt
  };
}

type OpenRouterToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

function openRouterToolKit(outposts?: AiOutpostRuntime): {
  definitions: unknown[];
  handlers: Record<string, OpenRouterToolHandler>;
} {
  const definitions = [
    {
      type: "function",
      function: {
        name: "outposts_list",
        description:
          "List paired Outposts, live Beacon connectivity, online peers, last known status, recent command results, and recent build logs.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "outpost_create_pairing",
        description:
          "Create a setup command for adding or configuring an Outpost with optional build hints.",
        parameters: {
          type: "object",
          properties: {
            beaconUrl: { type: "string" },
            displayName: { type: "string" },
            installCommand: { type: "string" },
            buildCommand: { type: "string" },
            outputDir: { type: "string" },
            projectName: { type: "string" },
            retainReleases: { type: "number" }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "outpost_send_command",
        description:
          "Send a typed command to a paired Outpost through Beacon. Commands include GET_STATE, PING, DOCTOR, DEPLOY, ROLLBACK, DETECT_APP, RUN_HEALTH_CHECK, and APPLY_RECIPE.",
        parameters: {
          type: "object",
          required: ["peerId", "command"],
          properties: {
            peerId: { type: "string" },
            command: {
              type: "object",
              required: ["type"],
              properties: {
                type: { type: "string" }
              },
              additionalProperties: true
            }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "host_inspect_local",
        description:
          "Inspect the local host for OS, RAM, runtimes, service managers, web servers, and listening ports.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "host_inspect_ssh",
        description:
          "Inspect a remote host over SSH using read-only checks for OS, RAM, runtimes, service managers, and listening ports.",
        parameters: {
          type: "object",
          required: ["sshTarget"],
          properties: {
            sshTarget: { type: "string", description: "SSH target as user@host or host." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "host_run_ssh_command",
        description:
          "Run a shell command on a remote host over SSH. Use host_inspect_ssh for read-only host specs such as RAM when possible.",
        parameters: {
          type: "object",
          required: ["sshTarget", "command"],
          properties: {
            sshTarget: { type: "string", description: "SSH target as user@host or host." },
            command: { type: "string", description: "Shell command to execute on the remote host." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "app_detect_local",
        description:
          "Detect app type, package manager, scripts, and recipe signals for a local project path.",
        parameters: {
          type: "object",
          required: ["projectPath"],
          properties: { projectPath: { type: "string" } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "health_http_check",
        description: "Run a read-only HTTP health check against a URL.",
        parameters: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string" }, timeoutMs: { type: "number" } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "provisioning_plan_local",
        description:
          "Create a local-host deployment readiness plan from host and app inspection signals.",
        parameters: {
          type: "object",
          required: ["projectPath"],
          properties: { projectPath: { type: "string" } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "recipes_list",
        description:
          "List deployment recipes available to Mothership and whether each recipe is implemented or planning-only.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "recipes_recommend_local",
        description:
          "Recommend deployment recipes for a local project path after detecting app signals.",
        parameters: {
          type: "object",
          required: ["projectPath"],
          properties: { projectPath: { type: "string" } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "mothership_bootstrap_vps",
        description:
          "Bootstrap a remote VPS host: provision node/docker, clone or copy an app repo, transfer/build the local Beacon and Outpost runtime when requested, pair Outpost, start services, and optionally deploy.",
        parameters: {
          type: "object",
          required: ["sshTarget", "repo"],
          properties: {
            sshTarget: { type: "string" },
            repo: { type: "string" },
            projectPath: { type: "string" },
            deploy: { type: "boolean" },
            runtimeSource: { type: "string", enum: ["local", "npm"] },
            localRuntimePath: { type: "string" },
            remoteRuntimePath: { type: "string" },
            startBeacon: { type: "boolean" },
            beaconPort: { type: "number" }
          },
          additionalProperties: false
        }
      }
    }
  ];

  const handlers: Record<string, OpenRouterToolHandler> = {
    outposts_list: async () =>
      runRecordedTool("outpost.list", "AI Operator: list Outposts", "mothership", {}, async () =>
        currentOutpostInventory(outposts)
      ),
    outpost_create_pairing: async (input) =>
      runRecordedTool(
        "outpost.create_pairing",
        "AI Operator: create Outpost pairing command",
        "mothership",
        input,
        async () =>
          createPairingCommand({
            beaconUrl: optionalStringInput(input, "beaconUrl"),
            displayName: optionalStringInput(input, "displayName"),
            buildHints: {
              installCommand: optionalStringInput(input, "installCommand"),
              buildCommand: optionalStringInput(input, "buildCommand"),
              outputDir: optionalStringInput(input, "outputDir"),
              projectName: optionalStringInput(input, "projectName"),
              retainReleases:
                typeof input.retainReleases === "number" && Number.isFinite(input.retainReleases)
                  ? input.retainReleases
                  : undefined
            }
          })
      ),
    outpost_send_command: async (input) => {
      if (!outposts) {
        throw new Error("Outpost runtime is unavailable in this context.");
      }
      const peerId = stringInput(input, "peerId");
      const command = parseOutpostCommand(input.command);
      return runRecordedTool(
        toolNameForOutpostCommand(command),
        `AI Operator: ${command.type} ${peerId}`,
        peerId,
        { peerId, command },
        async () => ({
          envelope: outposts.sendCommand(peerId, command),
          beacon: outposts.snapshot()
        })
      );
    },
    host_inspect_local: async () =>
      runRecordedTool(
        "host.inspect_local",
        "AI Operator: inspect local host",
        "local",
        {},
        (context) => inspectLocalHost(context)
      ),
    host_inspect_ssh: async (input) => {
      const sshTarget = stringInput(input, "sshTarget");
      return runRecordedTool(
        "host.inspect_ssh",
        `AI Operator: inspect remote host ${sshTarget}`,
        sshTarget,
        { sshTarget },
        (context) => inspectSshHost(sshTarget, context)
      );
    },
    host_run_ssh_command: async (input) => {
      const sshTarget = stringInput(input, "sshTarget");
      const command = stringInput(input, "command");
      return runRecordedTool(
        "host.run_ssh_command",
        `AI Operator: run ssh command on ${sshTarget}`,
        sshTarget,
        { sshTarget, command },
        (context) => runSshCommand(sshTarget, command, context)
      );
    },
    app_detect_local: async (input) => {
      const projectPath = stringInput(input, "projectPath");
      return runRecordedTool(
        "app.detect_local",
        `AI Operator: detect app ${projectPath}`,
        projectPath,
        { projectPath },
        (context) => detectLocalApp(projectPath, context)
      );
    },
    health_http_check: async (input) => {
      const url = stringInput(input, "url");
      const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
      return runRecordedTool(
        "health.http_check",
        `AI Operator: check ${url}`,
        url,
        { url, timeoutMs },
        (context) => runHttpHealthCheck(url, timeoutMs, context)
      );
    },
    provisioning_plan_local: async (input) => {
      const projectPath = stringInput(input, "projectPath");
      return runRecordedTool(
        "provisioning.plan_local",
        `AI Operator: plan local deployment ${projectPath}`,
        projectPath,
        { projectPath },
        (context) => createLocalProvisioningPlan(projectPath, context)
      );
    },
    recipes_list: async () =>
      runRecordedTool(
        "recipes.list",
        "AI Operator: list deployment recipes",
        "mothership",
        {},
        async () => ({ recipes: listDeploymentRecipes() })
      ),
    recipes_recommend_local: async (input) => {
      const projectPath = stringInput(input, "projectPath");
      return runRecordedTool(
        "recipes.recommend_local",
        `AI Operator: recommend recipes ${projectPath}`,
        projectPath,
        { projectPath },
        async (context) => {
          const app = await detectLocalApp(projectPath, context);
          return { app, recipes: recommendDeploymentRecipes(app.appTypes) };
        }
      );
    },
    mothership_bootstrap_vps: async (input) => {
      const sshTarget = stringInput(input, "sshTarget");
      const repo = stringInput(input, "repo");
      const projectPath = typeof input.projectPath === "string" ? input.projectPath : undefined;
      const deploy = typeof input.deploy === "boolean" ? input.deploy : undefined;
      const runtimeSource: BootstrapRequest["runtimeSource"] =
        input.runtimeSource === "local" || input.runtimeSource === "npm"
          ? input.runtimeSource
          : undefined;
      const localRuntimePath =
        typeof input.localRuntimePath === "string" ? input.localRuntimePath : undefined;
      const remoteRuntimePath =
        typeof input.remoteRuntimePath === "string" ? input.remoteRuntimePath : undefined;
      const startBeacon = typeof input.startBeacon === "boolean" ? input.startBeacon : undefined;
      const beaconPort = typeof input.beaconPort === "number" ? input.beaconPort : undefined;
      const toolInput = {
        sshTarget,
        repo,
        projectPath,
        deploy,
        runtimeSource,
        localRuntimePath,
        remoteRuntimePath,
        startBeacon,
        beaconPort
      };
      return runRecordedTool(
        "mothership.bootstrap_vps",
        `AI Operator: bootstrap VPS ${sshTarget}`,
        sshTarget,
        toolInput,
        async () => startBootstrap(toolInput)
      );
    }
  };

  return { definitions, handlers };
}

async function currentOutpostInventory(outposts?: AiOutpostRuntime): Promise<unknown> {
  const state = await loadMothershipState();
  return buildOutpostInventory(state, outposts?.snapshot());
}

async function runRecordedTool<TResult>(
  toolName: string,
  title: string,
  target: string,
  toolInput: unknown,
  run: (context: ToolRunContext) => Promise<TResult>
): Promise<unknown> {
  const execution = await executeTool({
    toolName,
    title,
    target,
    toolInput,
    source: "ai",
    run
  });
  return execution.result ?? execution;
}

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalStringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content);
}

function openRouterUsageSnapshot(
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined
): TokenUsage {
  return {
    inputTokens: usage?.promptTokens,
    outputTokens: usage?.completionTokens,
    totalTokens: usage?.totalTokens,
    requests: usage ? 1 : 0
  };
}

function addUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: sumOptional(current.inputTokens, next.inputTokens),
    outputTokens: sumOptional(current.outputTokens, next.outputTokens),
    totalTokens: sumOptional(current.totalTokens, next.totalTokens),
    requests: sumOptional(current.requests, next.requests)
  };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

/**
 * Reads the stored API key for a given provider.
 *
 * @param provider - AI provider identifier.
 * @returns The API key string.
 * @throws Error when the key is missing.
 */
export async function readProviderApiKey(
  provider: MothershipAiConfig["provider"]
): Promise<string> {
  return readApiKeyForProvider(provider);
}

/**
 * Returns a minimal plugin template for the given name.
 *
 * @param input - Plugin name and optional description.
 * @returns Template code string.
 */
export async function draftPlugin(input: {
  name: string;
  description?: string;
}): Promise<{ name: string; code: string }> {
  return {
    name: input.name,
    code: pluginTemplate(input.name)
  };
}

async function readApiKeyForProvider(provider: MothershipAiConfig["provider"]): Promise<string> {
  const path = mothershipPaths().aiSecrets;
  if (!(await pathExists(path))) {
    throw new Error("AI API key is missing.");
  }
  const secrets = JSON.parse(await readFile(path, "utf8")) as AiSecrets;
  const state = await loadMothershipState();
  const activeProvider = state.config.ai?.provider ?? "openai";
  const apiKey =
    secrets.apiKeys?.[provider] ?? (provider === activeProvider ? secrets.apiKey : undefined);
  if (!apiKey) {
    throw new Error("AI API key is missing.");
  }
  return apiKey;
}

async function readAiSecrets(): Promise<AiSecrets> {
  const path = mothershipPaths().aiSecrets;
  if (!(await pathExists(path))) {
    return {};
  }
  return JSON.parse(await readFile(path, "utf8")) as AiSecrets;
}

function extractPluginCode(message: string): string | undefined {
  const match = message.match(/```mothership-plugin\s*([\s\S]*?)```/);
  return match?.[1]?.trim();
}

function pluginNameFromPrompt(prompt: string): string {
  return prompt.split(/\s+/).slice(0, 6).join("-") || "ai-plugin";
}
