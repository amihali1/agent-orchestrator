import { Tier } from "../types";
import { Provider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { ClaudeCodeProvider } from "./claude-code";

/** Concrete model each tier resolves to. */
const TIER_MODELS: Record<Tier, string> = {
  smart: "claude-opus-4-8",
  cheap: "claude-haiku-4-5",
  local: "qwen3.5:9b",
};

const TIERS: Tier[] = ["smart", "cheap", "local"];

const cache = new Map<Tier, Provider>();

/** Return the (memoized) provider for a tier. */
export function getProvider(tier: Tier): Provider {
  const cached = cache.get(tier);
  if (cached) return cached;

  let provider: Provider;
  switch (tier) {
    case "smart":
      // Default: Claude Agent SDK on the subscription (no API credits). Set
      // SMART_PROVIDER=api to use the Developer Platform (API key) instead.
      provider =
        process.env.SMART_PROVIDER === "api"
          ? new AnthropicProvider(TIER_MODELS.smart)
          : new ClaudeCodeProvider("opus");
      break;
    case "cheap":
      provider = new AnthropicProvider(TIER_MODELS.cheap);
      break;
    case "local":
      provider = new OllamaProvider(TIER_MODELS.local);
      break;
  }

  cache.set(tier, provider);
  return provider;
}

/**
 * Resolve the tier an agent runs on. Precedence:
 *   env TIER_<AGENT> (e.g. TIER_TESTER=local)  >  agent's configured tier  >  "smart".
 *
 * Core agents default to "smart" — offloading a quality-sensitive agent (e.g. the
 * tester) to the local model is opt-in via env, not forced.
 */
export function resolveTier(
  agentName: string,
  configured?: Tier,
  env: NodeJS.ProcessEnv = process.env
): Tier {
  const raw = env[`TIER_${agentName.toUpperCase()}`]?.toLowerCase();
  if (raw && (TIERS as string[]).includes(raw)) return raw as Tier;
  return configured ?? "smart";
}
