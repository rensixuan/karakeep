import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateSegments } from "./translation-client";

describe("OpenAI translation adapter", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const segments = [
    { id: "one", text: "Hello" },
    { id: "two", text: "World" },
  ];
  const completion = (
    content: unknown,
    finish_reason = "stop",
    refusal: string | null = null,
  ) =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason,
            message: {
              content:
                typeof content === "string" ? content : JSON.stringify(content),
              refusal,
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("pins the official endpoint and validates a reordered structured response", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://untrusted.example/v1");
    vi.stubEnv("OPENAI_ORG_ID", "different-user-org");
    vi.stubEnv("OPENAI_PROJECT_ID", "different-user-project");
    fetchMock.mockResolvedValue(
      completion({
        translations: [
          { id: "two", text: "世界" },
          { id: "one", text: "你好" },
        ],
      }),
    );
    expect(
      await translateSegments("fake-test-key", "gpt-5.4-mini", segments),
    ).toEqual({ one: "你好", two: "世界" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has("OpenAI-Organization")).toBe(false);
    expect(headers.has("OpenAI-Project")).toBe(false);
    expect(body).toMatchObject({
      store: false,
      response_format: { type: "json_schema" },
    });
    expect(body.messages[1].content).toBe(JSON.stringify(segments));
  });
  it.each([
    { translations: [{ id: "one", text: "missing two" }] },
    {
      translations: [
        { id: "one", text: "first" },
        { id: "one", text: "duplicate" },
      ],
    },
    {
      translations: [
        { id: "one", text: "" },
        { id: "two", text: "second" },
      ],
    },
    {
      translations: [
        { id: "other", text: "wrong id" },
        { id: "two", text: "second" },
      ],
    },
    "invalid JSON",
  ])("rejects invalid or incomplete results", async (content) => {
    fetchMock.mockResolvedValue(completion(content));
    await expect(
      translateSegments("fake-test-key", "model", segments),
    ).rejects.toThrow("TRANSLATION_INCOMPLETE");
  });
  it("does not accept truncated or refused responses", async () => {
    fetchMock
      .mockResolvedValueOnce(completion({}, "length"))
      .mockResolvedValueOnce(completion({}, "stop", "Refused"));
    await expect(
      translateSegments("fake-test-key", "model", segments),
    ).rejects.toThrow("TRANSLATION_INCOMPLETE");
    await expect(
      translateSegments("fake-test-key", "model", segments),
    ).rejects.toThrow("TRANSLATION_REFUSED");
  });
  it.each([
    [401, "TRANSLATION_INVALID_KEY"],
    [429, "TRANSLATION_RATE_LIMITED"],
    [404, "TRANSLATION_MODEL_UNAVAILABLE"],
    [500, "TRANSLATION_FAILED"],
  ])("sanitizes HTTP %s and does not silently retry", async (status, code) => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "echoed fake-test-key and article" },
        }),
        { status: Number(status) },
      ),
    );
    await expect(
      translateSegments("fake-test-key", "model", segments),
    ).rejects.toThrow(String(code));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("sanitizes timeouts", async () => {
    fetchMock.mockRejectedValue(
      new DOMException("secret details", "AbortError"),
    );
    await expect(
      translateSegments("fake-test-key", "model", segments),
    ).rejects.toThrow("TRANSLATION_TIMEOUT");
  });
});
