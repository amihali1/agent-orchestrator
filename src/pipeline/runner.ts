import { AgentConfig, AgentOutput, AgentResult, PipelineContext, Tier } from "../types";
import { MemoryStore } from "../memory/store";
import { getProvider, resolveTier } from "../providers/router";
import { BudgetTracker } from "../budget/tracker";

const memory = new MemoryStore();

/** Max chars of a single recalled memory to inject. Full past outputs (whole code
 *  files) are re-sent on every call otherwise — the biggest avoidable input cost. */
const MEMORY_INJECT_MAX_CHARS = Number(process.env.MEMORY_INJECT_MAX_CHARS) || 1500;
/** How many past memories to inject (fallback recall). */
const MEMORY_RECALL_LIMIT = Number(process.env.MEMORY_RECALL_LIMIT) || 2;

/** Truncate injected context to cap tokens, marking what was dropped. */
export function truncateForInjection(text: string, max = MEMORY_INJECT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[…truncated ${text.length - max} chars for token efficiency]`;
}

export async function runAgent(
  agent: AgentConfig,
  context: PipelineContext,
  attempt: number,
  noMemory = false,
  tracker?: BudgetTracker,
  cachedPrefix?: string,
  tierOverride?: Tier
): Promise<AgentOutput> {
  const memories = noMemory ? [] : memory.recall(agent.name, context.task, MEMORY_RECALL_LIMIT);
  const previousResult = context.history[context.history.length - 1] as AgentResult | undefined;

  const userMessage = buildUserMessage(context.task, memories, previousResult);

  // A tierOverride bypasses resolveTier entirely, so it wins even over an env
  // TIER_<AGENT> setting (used by cost-tiered retry to escalate mid-task).
  const provider = getProvider(tierOverride ?? resolveTier(agent.name, agent.tier));
  const { output, usage } = await provider.complete({
    system: agent.systemPrompt,
    userMessage,
    maxTokens: 16384,
    cachedPrefix,
  });
  output.usage = usage;
  tracker?.record(usage);

  if (output.status === "success" && output.output && output.reasoning) {
    memory.save(agent.name, context.task, output.output, output.reasoning);
  }

  return output;
}

function buildUserMessage(
  task: string,
  memories: ReturnType<MemoryStore["recall"]>,
  previousResult?: AgentResult
): string {
  const parts: string[] = [`# Task\n${task}`];

  if (memories.length > 0) {
    parts.push(
      `# Relevant Past Decisions\n` +
        memories
          .map(
            (m) =>
              `**${m.agent_name}** previously handled a similar task:\n` +
              truncateForInjection(m.output)
          )
          .join("\n\n")
    );
  }

  if (previousResult) {
    parts.push(`# Input from ${previousResult.agentName}\n${previousResult.output}`);
    if (previousResult.feedback) {
      parts.push(`# Revision Feedback to Address\n${previousResult.feedback}`);
    }
  }

  return parts.join("\n\n---\n\n");
}
