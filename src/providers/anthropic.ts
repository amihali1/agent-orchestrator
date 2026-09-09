import Anthropic from "@anthropic-ai/sdk";
import { Usage } from "../types";
import { RateLimitError } from "../budget/errors";
import {
  CompletionRequest,
  CompletionResult,
  OUTPUT_TOOL,
  Provider,
  parseAgentOutput,
} from "./types";

const DEFAULT_RETRY_AFTER_SEC = 60;

/** Read a retry delay (seconds) from a 429 response's headers, falling back to a default. */
function retryAfterSeconds(headers: unknown): number {
  const h = headers as Record<string, string> | undefined;
  const raw =
    h?.["retry-after"] ??
    h?.["anthropic-ratelimit-tokens-reset"] ??
    h?.["anthropic-ratelimit-requests-reset"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETRY_AFTER_SEC;
}

/** Provider backed by the Claude API via the Anthropic SDK. */
export class AnthropicProvider implements Provider {
  private client = new Anthropic();

  constructor(private readonly model: string) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let response: Anthropic.Message;
    try {
      // With a cached prefix, send system as blocks and put a cache breakpoint at
      // the end of the (large, stable) prefix. Without one, keep the plain string.
      const system: string | Anthropic.TextBlockParam[] = req.cachedPrefix
        ? [
            { type: "text", text: req.cachedPrefix, cache_control: { type: "ephemeral" } },
            { type: "text", text: req.system },
          ]
        : req.system;

      response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        system,
        tools: [OUTPUT_TOOL],
        messages: [{ role: "user", content: req.userMessage }],
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 429) {
        const sec = retryAfterSeconds((err as { headers?: unknown }).headers);
        throw new RateLimitError(sec, Date.now() + sec * 1000);
      }
      throw err;
    }

    // The model's free text (used as fallback when the tool output is empty).
    const textContent = response.content
      .filter((c) => c.type === "text")
      .map((c) => (c as Anthropic.TextBlock).text)
      .join("\n\n")
      .trim();

    const toolUse = response.content.find((c) => c.type === "tool_use");
    const raw =
      toolUse && toolUse.type === "tool_use"
        ? (toolUse.input as Record<string, unknown>)
        : undefined;

    const output = parseAgentOutput(raw, textContent);

    const usage: Usage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };

    return { output, usage, provider: "anthropic", model: this.model };
  }
}
