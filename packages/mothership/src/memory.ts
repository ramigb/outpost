import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathExists, writeJsonFile } from "@outpost/shared";

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
};

export type AgentContextUsage = {
  model: string;
  contextWindowTokens: number;
  estimatedInputTokens: number;
  estimatedMemoryTokens: number;
  estimatedUserTokens: number;
  estimatedAvailableTokens: number;
  actual?: TokenUsage;
  updatedAt: string;
};

export type MemoryTurn = {
  at: string;
  user: string;
  assistant: string;
  toolCalls: number;
};

export type MemoryState = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  summary: string;
  recentTurns: MemoryTurn[];
  lastUsage?: AgentContextUsage;
};

export type AgentMemoryBootstrap = {
  context: string;
  usage: AgentContextUsage;
};

const MAX_SUMMARY_CHARS = 1800;
const MAX_RECENT_TURNS = 4;
const MAX_USER_CHARS = 700;
const MAX_ASSISTANT_CHARS = 900;
const EMPTY_SUMMARY = "No durable session facts yet.";

export function isResetCommand(message: string): boolean {
  return message.trim().toLowerCase() === "/reset";
}

export function memoryPaths(
  base = process.env.MOTHERSHIP_MEMORY_DIR ?? join(process.cwd(), ".memory")
) {
  return {
    base,
    state: join(base, "session.json"),
    context: join(base, "context.md"),
    usage: join(base, "usage.json")
  };
}

export async function resetAgentMemory(): Promise<MemoryState> {
  const paths = memoryPaths();
  await rm(paths.base, { recursive: true, force: true });
  return writeMemoryState(defaultMemoryState());
}

export async function buildAgentMemoryBootstrap(
  model: string,
  userMessage: string
): Promise<AgentMemoryBootstrap> {
  const state = await readMemoryState();
  const context = renderMemoryContext(state);
  const contextWindowTokens = contextWindowForModel(model);
  const estimatedMemoryTokens = estimateTokens(context);
  const estimatedUserTokens = estimateTokens(userMessage);
  const estimatedInputTokens = estimatedMemoryTokens + estimatedUserTokens;
  return {
    context,
    usage: {
      model,
      contextWindowTokens,
      estimatedInputTokens,
      estimatedMemoryTokens,
      estimatedUserTokens,
      estimatedAvailableTokens: Math.max(0, contextWindowTokens - estimatedInputTokens),
      updatedAt: new Date().toISOString()
    }
  };
}

export async function appendAgentMemory(input: {
  userMessage: string;
  assistantMessage: string;
  toolCalls?: number;
  usage: AgentContextUsage;
  actualUsage?: TokenUsage;
}): Promise<MemoryState> {
  const state = await readMemoryState();
  const turn: MemoryTurn = {
    at: new Date().toISOString(),
    user: compactText(input.userMessage, MAX_USER_CHARS),
    assistant: compactText(input.assistantMessage, MAX_ASSISTANT_CHARS),
    toolCalls: input.toolCalls ?? 0
  };
  const next: MemoryState = {
    ...state,
    updatedAt: turn.at,
    summary: compactSummary(state.summary, turn),
    recentTurns: [...state.recentTurns, turn].slice(-MAX_RECENT_TURNS),
    lastUsage: {
      ...input.usage,
      actual: input.actualUsage,
      updatedAt: turn.at
    }
  };
  return writeMemoryState(next);
}

export async function getAgentMemorySnapshot(): Promise<
  MemoryState & { paths: ReturnType<typeof memoryPaths> }
> {
  const state = await readMemoryState();
  return { ...state, paths: memoryPaths() };
}

function defaultMemoryState(): MemoryState {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    summary: EMPTY_SUMMARY,
    recentTurns: []
  };
}

async function readMemoryState(): Promise<MemoryState> {
  const paths = memoryPaths();
  await mkdir(paths.base, { recursive: true });
  if (!(await pathExists(paths.state))) {
    return writeMemoryState(defaultMemoryState());
  }
  const parsed = JSON.parse(await readFile(paths.state, "utf8")) as Partial<MemoryState>;
  return {
    version: 1,
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary : EMPTY_SUMMARY,
    recentTurns: Array.isArray(parsed.recentTurns)
      ? parsed.recentTurns.slice(-MAX_RECENT_TURNS).map(normalizeTurn)
      : [],
    lastUsage: parsed.lastUsage
  };
}

async function writeMemoryState(state: MemoryState): Promise<MemoryState> {
  const paths = memoryPaths();
  await writeJsonFile(paths.state, state, 0o600);
  await writeTextFile(paths.context, renderMemoryContext(state), 0o600);
  if (state.lastUsage) {
    await writeJsonFile(paths.usage, state.lastUsage, 0o600);
  }
  return state;
}

async function writeTextFile(path: string, value: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { mode });
}

function normalizeTurn(value: Partial<MemoryTurn>): MemoryTurn {
  return {
    at: typeof value.at === "string" ? value.at : new Date().toISOString(),
    user: compactText(typeof value.user === "string" ? value.user : "", MAX_USER_CHARS),
    assistant: compactText(
      typeof value.assistant === "string" ? value.assistant : "",
      MAX_ASSISTANT_CHARS
    ),
    toolCalls: typeof value.toolCalls === "number" ? value.toolCalls : 0
  };
}

function renderMemoryContext(state: MemoryState): string {
  const lines = ["Mothership session memory:", `Summary: ${state.summary.trim() || EMPTY_SUMMARY}`];
  if (state.recentTurns.length > 0) {
    lines.push("Recent turns:");
    for (const turn of state.recentTurns) {
      lines.push(`- ${turn.at}`);
      lines.push(`  User: ${turn.user}`);
      lines.push(`  Assistant: ${turn.assistant}`);
      if (turn.toolCalls > 0) {
        lines.push(`  Tool calls: ${turn.toolCalls}`);
      }
    }
  }
  lines.push(
    "Use this memory as compact context only. Current user input and tool results override stale memory."
  );
  return `${lines.join("\n")}\n`;
}

function compactSummary(previous: string, turn: MemoryTurn): string {
  const existing = previous === EMPTY_SUMMARY ? "" : previous.trim();
  const nextLine = `- ${turn.at}: User asked "${singleLine(turn.user, 180)}"; assistant answered "${singleLine(turn.assistant, 220)}".`;
  return compactText([existing, nextLine].filter(Boolean).join("\n"), MAX_SUMMARY_CHARS);
}

function compactText(value: string, maxChars: number): string {
  const compacted = singleLine(value, maxChars * 2);
  if (compacted.length <= maxChars) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxChars - 12)).trim()} ...`;
}

function singleLine(value: string, maxChars: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function contextWindowForModel(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes("gpt-4.1") || normalized.includes("gpt-5")) return 1_000_000;
  if (normalized.includes("gemini-1.5") || normalized.includes("gemini-2.5")) return 1_000_000;
  if (
    normalized.includes("claude-3") ||
    normalized.includes("claude-sonnet") ||
    normalized.includes("claude-opus")
  )
    return 200_000;
  if (normalized.includes("o3") || normalized.includes("o4")) return 200_000;
  if (normalized.includes("gpt-4o") || normalized.includes("gpt-4-turbo")) return 128_000;
  return 128_000;
}
