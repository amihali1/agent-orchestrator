/** Model tier an agent runs on. Mapped to a concrete provider/model by the router. */
export type Tier = "smart" | "cheap" | "local";

/** Token usage reported by a provider for a single completion. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Whether these tokens count against the Claude budget. Defaults to true.
   * Local (Ollama) inference is free, so it reports `false` — the tokens are still
   * counted for visibility, but never consume the run/day cap.
   */
  billable?: boolean;
}

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  /** Which agent to jump back to when this agent requests a revision */
  onRevision?: string;
  /** Max times this agent can be retried (default: 3) */
  maxRetries?: number;
  /** Model tier for this agent (default: "smart") */
  tier?: Tier;
}

export interface AgentOutput {
  status: "success" | "needs_revision";
  output: string;
  feedback?: string;
  reasoning: string;
  /** Token usage for the completion that produced this output (set by the provider). */
  usage?: Usage;
}

export interface AgentResult extends AgentOutput {
  agentName: string;
  timestamp: Date;
  attempt: number;
}

export interface PipelineContext {
  task: string;
  history: AgentResult[];
}

export interface PipelineOptions {
  agents: AgentConfig[];
  noMemory?: boolean;
  onAgentComplete?: (result: AgentResult) => void;
  /** Budget tracker for token accounting/caps. Defaults to env-configured tracker. */
  tracker?: import("./budget/tracker").BudgetTracker;
  /** Checkpoint store for pause/resume. Defaults to on-disk checkpoints.db. */
  checkpoint?: import("./checkpoint/store").CheckpointStore;
}

export interface MemoryRecord {
  id: string;
  agent_name: string;
  input_hash: string;
  task: string;
  output: string;
  reasoning: string;
  created_at: string;
}
