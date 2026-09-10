import Anthropic from "@anthropic-ai/sdk";
import { AgentOutput, Usage } from "../types";

/** A single model call, backend-agnostic. */
export interface CompletionRequest {
  system: string;
  userMessage: string;
  maxTokens: number;
  /**
   * Large, stable context (e.g. gathered repo files) sent ahead of the system
   * prompt. Anthropic marks it with cache_control so it's cached across the
   * revision loop; other backends just prepend it. Optional.
   */
  cachedPrefix?: string;
}

/** Parsed agent output plus token accounting and which backend served it. */
export interface CompletionResult {
  output: AgentOutput;
  usage: Usage;
  provider: string;
  model: string;
}

/** A model backend. Anthropic and (Phase 5) Ollama implement this. */
export interface Provider {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Structured-output tool. Forces the model to return its deliverable in a
 * predictable shape. Native tool-use backends (Anthropic) pass this directly;
 * backends without tool-use (Ollama, Phase 5) embed OUTPUT_SCHEMA_PROMPT instead.
 */
export const OUTPUT_TOOL: Anthropic.Tool = {
  name: "submit_output",
  description:
    "Submit your completed output for this stage of the pipeline. " +
    "IMPORTANT: You MUST include your COMPLETE deliverable in the 'output' field. " +
    "Do NOT put your work in the text response — only the 'output' field will be read by the next agent.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["success", "needs_revision"],
        description:
          "'success' = pass to next agent. 'needs_revision' = previous agent must redo their work.",
      },
      output: {
        type: "string",
        description:
          "Your COMPLETE deliverable for this stage. This is the ONLY field the next agent will see. " +
          "Include ALL of your work here — code, specs, test suites, review notes, etc.",
      },
      feedback: {
        type: "string",
        description:
          "Required if status is 'needs_revision'. Specific, actionable feedback for the previous agent.",
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of your decision.",
      },
    },
    required: ["status", "output", "reasoning"],
  },
};

/**
 * Plain-text description of the same JSON contract as OUTPUT_TOOL, for providers
 * without native tool-use. Consumed by the Ollama provider in Phase 5.
 */
export const OUTPUT_SCHEMA_PROMPT = `Respond with ONLY a single JSON object, no prose, matching:
{
  "status": "success" | "needs_revision",  // "success" = pass to next agent; "needs_revision" = previous agent redoes work
  "output": string,                          // your COMPLETE deliverable — the ONLY field the next agent sees
  "reasoning": string,                       // brief explanation of your decision
  "feedback"?: string                        // required only when status is "needs_revision"
}`;

/**
 * Extract an AgentOutput from a model's raw structured input and/or free text.
 * Shared by all providers so extraction/fallback rules stay identical.
 *
 * @param raw          Parsed structured output (tool_use input or parsed JSON), if any.
 * @param fallbackText Free-text the model emitted; used when `output` is missing/empty.
 */
/** Coerce a model-supplied field to a string — some models return arrays/objects
 *  (e.g. a JSON task array) where we expect text. Non-strings are JSON-stringified so
 *  they stay usable downstream (and safe to persist). */
function toText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return JSON.stringify(v);
}

export function parseAgentOutput(
  raw: Record<string, unknown> | undefined,
  fallbackText: string
): AgentOutput {
  if (raw) {
    return {
      status: (raw.status as AgentOutput["status"]) ?? "success",
      output: toText(raw.output) || fallbackText || "",
      reasoning: toText(raw.reasoning),
      feedback: raw.feedback == null ? undefined : toText(raw.feedback),
    };
  }
  // No structured output — treat free text as a successful deliverable.
  return {
    status: "success",
    output: fallbackText,
    reasoning: "",
  };
}

/**
 * Best-effort JSON extraction for prompt-and-parse providers (Ollama, Claude Agent
 * SDK) that have no native tool-use: try the whole string, then the first {...} block.
 */
export function extractJson(content: string): Record<string, unknown> | undefined {
  const tryParse = (s: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(content);
  if (whole) return whole;
  const block = content.match(/\{[\s\S]*\}/);
  return block ? tryParse(block[0]) : undefined;
}
