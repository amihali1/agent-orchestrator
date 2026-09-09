import { query } from "@anthropic-ai/claude-agent-sdk";
import { Usage } from "../types";
import { RateLimitError } from "../budget/errors";
import {
  CompletionRequest,
  CompletionResult,
  OUTPUT_SCHEMA_PROMPT,
  Provider,
  extractJson,
  parseAgentOutput,
} from "./types";

const DEFAULT_RETRY_AFTER_SEC = 300;
// Claude Code's own tools — disabled so this is a plain single-shot completion.
const CC_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];

/**
 * Subprocess env for the Agent SDK, with ANTHROPIC_API_KEY stripped. A set API key
 * shadows the subscription login — Claude Code would bill Developer Platform credits
 * instead of the Pro/Max plan. Removing it forces the OAuth/subscription path
 * (CLAUDE_CODE_OAUTH_TOKEN or the CLI's stored login).
 */
function subscriptionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_API_KEY") continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Provider that runs single-shot completions through the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`, which wraps the Claude Code CLI). Authenticated
 * via CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), calls draw on the user's
 * Claude subscription instead of Developer Platform API credits.
 *
 * Like the Ollama provider, it has no native tool-use: the structured-output contract
 * is embedded via OUTPUT_SCHEMA_PROMPT and parsed with the shared helpers. Tools are
 * disabled and maxTurns is 1 so it behaves as a plain assistant, not an agent.
 */
export class ClaudeCodeProvider implements Provider {
  constructor(private readonly model: string = "opus") {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const prompt = [req.cachedPrefix, req.userMessage, OUTPUT_SCHEMA_PROMPT]
      .filter(Boolean)
      .join("\n\n");

    let text: string | undefined;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const message of query({
        prompt,
        options: {
          systemPrompt: req.system,
          model: this.model,
          permissionMode: "bypassPermissions",
          maxTurns: 1,
          settingSources: [],
          allowedTools: [],
          disallowedTools: CC_TOOLS,
          env: subscriptionEnv(),
        },
      })) {
        if (message.type === "result") {
          if (message.subtype === "success") {
            // `result` is the final assistant text for the turn.
            text = message.result;
            usage = {
              inputTokens: message.usage.input_tokens ?? 0,
              outputTokens: message.usage.output_tokens ?? 0,
            };
          } else {
            throw new Error(`Claude Agent SDK ended with ${message.subtype}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Subscription usage/rate limits don't expose a reset time like the API's
      // retry-after; map to a pause with a default delay (best-effort auto-sleep).
      if (/rate.?limit|usage limit|quota|too many requests/i.test(msg)) {
        throw new RateLimitError(
          DEFAULT_RETRY_AFTER_SEC,
          Date.now() + DEFAULT_RETRY_AFTER_SEC * 1000
        );
      }
      throw err;
    }

    const finalText = (text ?? "").trim();
    const output = parseAgentOutput(extractJson(finalText), finalText);
    return { output, usage, provider: "claude-code", model: this.model };
  }
}
