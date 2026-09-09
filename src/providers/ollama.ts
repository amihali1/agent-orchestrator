import { Usage } from "../types";
import {
  CompletionRequest,
  CompletionResult,
  OUTPUT_SCHEMA_PROMPT,
  Provider,
  extractJson,
  parseAgentOutput,
} from "./types";

const DEFAULT_HOST = "http://10.0.0.47:11434";
const DEFAULT_TIMEOUT_MS = 120_000;

interface OllamaChatResponse {
  message?: { content?: string };
}

/**
 * Provider backed by a local/remote Ollama server (default: homelab 10.0.0.47).
 * No native tool-use, so the structured-output contract is embedded in the system
 * prompt (OUTPUT_SCHEMA_PROMPT) and enforced with `format: "json"`. Local inference
 * is free, so usage is reported as zero — it never consumes the Claude token budget.
 *
 * Cost here is wall-clock, not tokens, so output is NOT length-capped (capping only
 * risks truncation); a request timeout guards against a runaway generation instead.
 */
export class OllamaProvider implements Provider {
  constructor(
    private readonly model: string,
    private readonly host: string = process.env.OLLAMA_HOST ?? DEFAULT_HOST,
    private readonly timeoutMs: number = Number(process.env.OLLAMA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          format: "json",
          stream: false,
          // qwen3.5 is a thinking model; its chain-of-thought consumes the token
          // budget and can leave `content` empty. We capture reasoning separately,
          // so disable thinking for deterministic, cheaper structured output.
          think: false,
          messages: [
            {
              role: "system",
              content: [req.cachedPrefix, req.system, OUTPUT_SCHEMA_PROMPT]
                .filter(Boolean)
                .join("\n\n"),
            },
            { role: "user", content: req.userMessage },
          ],
          // No num_predict cap — local generation is free; the timeout is the guard.
        }),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Ollama ${this.host} request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama ${this.host} returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const content = (data.message?.content ?? "").trim();
    const output = parseAgentOutput(extractJson(content), content);

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    return { output, usage, provider: "ollama", model: this.model };
  }
}
