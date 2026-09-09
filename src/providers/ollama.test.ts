import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "./ollama";
import { OUTPUT_SCHEMA_PROMPT } from "./types";

function okResponse(content: string) {
  return { ok: true, json: async () => ({ message: { content } }) };
}

const req = { system: "You are a formatter.", userMessage: "format this", maxTokens: 256 };

describe("OllamaProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("posts a format:json chat request with the schema in the system prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse('{"status":"success","output":"done","reasoning":"ok"}')
    );
    vi.stubGlobal("fetch", fetchMock);

    await new OllamaProvider("qwen3.5:9b", "http://host:11434").complete(req);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://host:11434/api/chat");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen3.5:9b");
    expect(body.format).toBe("json");
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("You are a formatter.");
    expect(body.messages[0].content).toContain(OUTPUT_SCHEMA_PROMPT);
    expect(body.messages[1]).toEqual({ role: "user", content: "format this" });
  });

  it("parses the JSON content into an AgentOutput and reports zero usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse('{"status":"needs_revision","output":"","reasoning":"bug","feedback":"fix line 3"}')
      )
    );

    const { output, usage, provider } = await new OllamaProvider("qwen3.5:9b").complete(req);

    expect(output.status).toBe("needs_revision");
    expect(output.feedback).toBe("fix line 3");
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(provider).toBe("ollama");
  });

  it("extracts a JSON block when the model wraps it in stray text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse('here you go: {"status":"success","output":"x","reasoning":"y"} done')
      )
    );

    const { output } = await new OllamaProvider("qwen3.5:9b").complete(req);
    expect(output.output).toBe("x");
  });

  it("falls back to raw text when content is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("totally not json")));

    const { output } = await new OllamaProvider("qwen3.5:9b").complete(req);
    expect(output.status).toBe("success");
    expect(output.output).toBe("totally not json");
  });

  it("aborts and throws a timeout error when the request exceeds timeoutMs", async () => {
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      })
    );

    await expect(
      new OllamaProvider("qwen3.5:9b", "http://host:11434", 20).complete(req)
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("does not send a num_predict cap (local output is uncapped)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse('{"status":"success","output":"x","reasoning":"y"}')
    );
    vi.stubGlobal("fetch", fetchMock);

    await new OllamaProvider("qwen3.5:9b").complete(req);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options?.num_predict).toBeUndefined();
    expect(body.think).toBe(false);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" })
    );

    await expect(new OllamaProvider("qwen3.5:9b", "http://host:11434").complete(req)).rejects.toThrow(
      /503/
    );
  });
});
