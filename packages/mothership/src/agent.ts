import { Agent, OpenAIProvider, Runner, setTracingDisabled, tool } from "@openai/agents";
import { z } from "zod";
import { listDeploymentRecipes, recommendDeploymentRecipes } from "@outpost/shared";
import { readProviderApiKey, getAiStatus } from "./ai.js";
import {
  createLocalProvisioningPlan,
  detectLocalApp,
  inspectLocalHost,
  runHttpHealthCheck,
  inspectSshHost,
  runSshCommand
} from "./provisioning.js";
import { startBootstrap } from "./bootstrap.js";
import { executeTool } from "./tools.js";

const MAX_AGENT_TURNS = 500;

export type AgentStreamEvent =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "tool_result"; toolName: string; result: unknown }
  | { type: "warning"; message: string; used: number; limit: number; resetAt: string }
  | { type: "message"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type DeploymentAgentResult = {
  message: string;
  provider: "openai";
  toolCalls: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    requests?: number;
  };
};

export async function runDeploymentAgent(input: {
  message: string;
  memoryContext?: string;
}): Promise<DeploymentAgentResult> {
  const status = await getAiStatus();
  if (status.provider !== "openai") {
    throw new Error("Agents SDK orchestration is currently enabled only for the OpenAI provider.");
  }
  const apiKey = await readProviderApiKey("openai");

  // Keep Mothership's operation history as the primary local audit trail.
  setTracingDisabled(true);

  const provider = new OpenAIProvider({
    apiKey,
    baseURL: status.baseUrl,
    useResponses: true
  });
  const agent = new Agent({
    name: "Outpost Deployment Operator",
    model: status.defaultModel,
    instructions: [
      "You are the Outpost Mothership deployment operator.",
      "Your job is deployment planning, provisioning inspection, health checking, and safe operation of apps on user-owned infrastructure.",
      "You can connect to remote VPS targets over SSH to inspect host specs, run commands (such as git cloning repositories or checking directory structures), and bootstrap Outpost node/docker environments.",
      "For SSH questions about OS, runtimes, ports, or RAM, call host_inspect_ssh before answering.",
      "You are not a general coding assistant and must not propose source-code edits unless the user explicitly asks for code help outside deployment.",
      "Use the available Mothership tools for factual inspection before making deployment claims.",
      "If a needed capability is missing, name the missing tool or recipe instead of inventing hidden capabilities.",
      "Beacon strict mode never permits arbitrary shell commands. Outpost actions must remain typed commands.",
      input.memoryContext
        ? input.memoryContext
        : "Mothership session memory: No durable session facts yet.",
      "Keep responses concise and include the next concrete deployment step."
    ].join("\n"),
    tools: [
      inspectLocalHostTool,
      detectLocalAppTool,
      listRecipesTool,
      recommendRecipesTool,
      planLocalDeploymentTool,
      httpHealthCheckTool,
      inspectSshHostTool,
      runSshCommandTool,
      bootstrapVpsTool
    ]
  });

  const runner = new Runner({
    modelProvider: provider,
    tracingDisabled: true
  });
  const result = await runner.run(agent, input.message, {
    maxTurns: MAX_AGENT_TURNS,
    toolExecution: {
      maxFunctionToolConcurrency: 1
    }
  });

  await provider.close();
  return {
    message: String(result.finalOutput ?? ""),
    provider: "openai",
    toolCalls: result.newItems.filter((item) => item.type === "tool_call_item").length,
    usage: usageSnapshot(result.runContext.usage)
  };
}

export async function* runDeploymentAgentStreamed(input: {
  message: string;
  memoryContext?: string;
}): AsyncGenerator<AgentStreamEvent, DeploymentAgentResult, unknown> {
  const status = await getAiStatus();
  if (status.provider !== "openai") {
    throw new Error("Agents SDK orchestration is currently enabled only for the OpenAI provider.");
  }
  const apiKey = await readProviderApiKey("openai");

  setTracingDisabled(true);

  const provider = new OpenAIProvider({
    apiKey,
    baseURL: status.baseUrl,
    useResponses: true
  });
  const agent = new Agent({
    name: "Outpost Deployment Operator",
    model: status.defaultModel,
    instructions: [
      "You are the Outpost Mothership deployment operator.",
      "Your job is deployment planning, provisioning inspection, health checking, and safe operation of apps on user-owned infrastructure.",
      "You can connect to remote VPS targets over SSH to inspect host specs, run commands (such as git cloning repositories or checking directory structures), and bootstrap Outpost node/docker environments.",
      "For SSH questions about OS, runtimes, ports, or RAM, call host_inspect_ssh before answering.",
      "You are not a general coding assistant and must not propose source-code edits unless the user explicitly asks for code help outside deployment.",
      "Use the available Mothership tools for factual inspection before making deployment claims.",
      "If a needed capability is missing, name the missing tool or recipe instead of inventing hidden capabilities.",
      "Beacon strict mode never permits arbitrary shell commands. Outpost actions must remain typed commands.",
      input.memoryContext
        ? input.memoryContext
        : "Mothership session memory: No durable session facts yet.",
      "Keep responses concise and include the next concrete deployment step."
    ].join("\n"),
    tools: [
      inspectLocalHostTool,
      detectLocalAppTool,
      listRecipesTool,
      recommendRecipesTool,
      planLocalDeploymentTool,
      httpHealthCheckTool,
      inspectSshHostTool,
      runSshCommandTool,
      bootstrapVpsTool
    ]
  });

  const runner = new Runner({
    modelProvider: provider,
    tracingDisabled: true
  });

  yield { type: "thinking", content: "Analyzing request and planning approach..." };

  try {
    const result = await runner.run(agent, input.message, {
      stream: true,
      maxTurns: MAX_AGENT_TURNS,
      toolExecution: {
        maxFunctionToolConcurrency: 1
      }
    });

    for await (const event of result) {
      if (event.type !== "run_item_stream_event") {
        continue;
      }
      if (event.name === "tool_called") {
        const toolCall = toolCallEvent(event.item);
        yield { type: "tool_call", toolName: toolCall.name, input: toolCall.input };
      } else if (event.name === "tool_output") {
        const toolOutput = toolOutputEvent(event.item);
        yield { type: "tool_result", toolName: toolOutput.name, result: toolOutput.result };
      }
    }

    await result.completed;
    const message = String(result.finalOutput ?? "");
    yield { type: "message", content: message };
    yield { type: "done" };

    await provider.close();
    return {
      message,
      provider: "openai",
      toolCalls: result.newItems.filter((item) => item.type === "tool_call_item").length,
      usage: usageSnapshot(result.runContext.usage)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: "error", message };
    await provider.close();
    throw error;
  }
}

function toolCallEvent(item: unknown): { name: string; input: unknown } {
  const rawItem = (item as { rawItem?: { name?: string; arguments?: string } }).rawItem;
  const args =
    typeof rawItem?.arguments === "string"
      ? parseJsonOrText(rawItem.arguments)
      : rawItem?.arguments;
  return {
    name: rawItem?.name ?? "unknown",
    input: args ?? {}
  };
}

function toolOutputEvent(item: unknown): { name: string; result: unknown } {
  const outputItem = item as { rawItem?: { name?: string; output?: unknown }; output?: unknown };
  return {
    name: outputItem.rawItem?.name ?? "unknown",
    result: outputItem.output ?? outputItem.rawItem?.output
  };
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function usageSnapshot(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
}) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    requests: usage.requests
  };
}

const inspectLocalHostTool = tool({
  name: "host_inspect_local",
  description:
    "Inspect the local host for OS, runtimes, service managers, web servers, and listening ports.",
  parameters: z.object({}),
  async execute() {
    const execution = await executeTool({
      toolName: "host.inspect_local",
      title: "AI Operator: inspect local host",
      target: "local",
      toolInput: {},
      source: "ai",
      run: (context) => inspectLocalHost(context)
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});

const detectLocalAppTool = tool({
  name: "app_detect_local",
  description:
    "Detect app type, package manager, scripts, and recipe signals for a local project path.",
  parameters: z.object({
    projectPath: z
      .string()
      .describe("Local project path to inspect, for example . or /srv/apps/site")
  }),
  async execute(input) {
    const execution = await executeTool({
      toolName: "app.detect_local",
      title: `AI Operator: detect app ${input.projectPath}`,
      target: input.projectPath,
      toolInput: input,
      source: "ai",
      run: (context) => detectLocalApp(input.projectPath, context)
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});

const httpHealthCheckTool = tool({
  name: "health_http_check",
  description: "Run a read-only HTTP health check against a URL.",
  parameters: z.object({
    url: z.string().url(),
    timeoutMs: z.number().int().positive().max(30_000).optional()
  }),
  async execute(input) {
    const execution = await executeTool({
      toolName: "health.http_check",
      title: `AI Operator: check ${input.url}`,
      target: input.url,
      toolInput: input,
      source: "ai",
      run: (context) => runHttpHealthCheck(input.url, input.timeoutMs, context)
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});

const listRecipesTool = tool({
  name: "recipes_list",
  description:
    "List deployment recipes available to Mothership and whether each recipe is implemented or planning-only.",
  parameters: z.object({}),
  async execute() {
    const execution = await executeTool({
      toolName: "recipes.list",
      title: "AI Operator: list deployment recipes",
      target: "mothership",
      toolInput: {},
      source: "ai",
      run: async () => ({ recipes: listDeploymentRecipes() })
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});

const recommendRecipesTool = tool({
  name: "recipes_recommend_local",
  description: "Recommend deployment recipes for a local project path after detecting app signals.",
  parameters: z.object({
    projectPath: z
      .string()
      .describe("Local project path to inspect and match against deployment recipes")
  }),
  async execute(input) {
    const execution = await executeTool({
      toolName: "recipes.recommend_local",
      title: `AI Operator: recommend recipes ${input.projectPath}`,
      target: input.projectPath,
      toolInput: input,
      source: "ai",
      run: async (context) => {
        const app = await detectLocalApp(input.projectPath, context);
        return { app, recipes: recommendDeploymentRecipes(app.appTypes) };
      }
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});

const planLocalDeploymentTool = tool({
  name: "provisioning_plan_local",
  description:
    "Create a local-host deployment readiness plan from host and app inspection signals.",
  parameters: z.object({
    projectPath: z.string().describe("Local project path to inspect and plan for, for example .")
  }),
  async execute(input) {
    const execution = await executeTool({
      toolName: "provisioning.plan_local",
      title: `AI Operator: plan local deployment ${input.projectPath}`,
      target: input.projectPath,
      toolInput: input,
      source: "ai",
      run: (context) => createLocalProvisioningPlan(input.projectPath, context)
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});

const inspectSshHostTool = tool({
  name: "host_inspect_ssh",
  description:
    "Inspect a remote host over SSH using read-only checks for OS, RAM, runtimes, service managers, and listening ports.",
  parameters: z.object({
    sshTarget: z.string().describe("SSH target as user@host or host")
  }),
  async execute(input) {
    const execution = await executeTool({
      toolName: "host.inspect_ssh",
      title: `AI Operator: inspect remote host ${input.sshTarget}`,
      target: input.sshTarget,
      toolInput: input,
      source: "ai",
      run: (context) => inspectSshHost(input.sshTarget, context)
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});

const runSshCommandTool = tool({
  name: "host_run_ssh_command",
  description:
    "Run a shell command on a remote host over SSH, such as checking files, cloning a git repo, or starting services.",
  parameters: z.object({
    sshTarget: z.string().describe("SSH target as user@host or host"),
    command: z.string().describe("Shell command to execute on the remote host")
  }),
  async execute(input) {
    const execution = await executeTool({
      toolName: "host.run_ssh_command",
      title: `AI Operator: run ssh command on ${input.sshTarget}`,
      target: input.sshTarget,
      toolInput: input,
      source: "ai",
      run: (context) => runSshCommand(input.sshTarget, input.command, context)
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});

const bootstrapVpsTool = tool({
  name: "mothership_bootstrap_vps",
  description:
    "Bootstrap a remote VPS host: provision node/docker, clone a git repo, pair Outpost, and optionally deploy.",
  parameters: z.object({
    sshTarget: z.string().describe("SSH target as user@host or host"),
    repo: z.string().describe("Git repository URL to clone (remote URL or local path)"),
    projectPath: z
      .string()
      .optional()
      .describe("Remote project path on VPS. Defaults to outpost-apps/<repo-name>"),
    deploy: z.boolean().optional().describe("Whether to trigger automated deployment after setup")
  }),
  async execute(input) {
    const execution = await executeTool({
      toolName: "mothership.bootstrap_vps",
      title: `AI Operator: bootstrap VPS ${input.sshTarget}`,
      target: input.sshTarget,
      toolInput: input,
      source: "ai",
      run: () => startBootstrap(input)
    });
    return JSON.stringify(execution.result ?? execution, null, 2);
  }
});
