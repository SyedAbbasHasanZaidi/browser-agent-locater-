import { describe, it, expect, vi, beforeEach } from "vitest";
import { VisionClient, VisionServiceError } from "../../src/transport/vision-client.js";

// ---------------------------------------------------------------------------
// Purpose: Black-box tests for VisionClient
//
// VisionClient adapts HTTP fetch() calls to a typed TypeScript interface.
// These tests verify:
//   - locate() sends the correct JSON body and headers
//   - BYOK: when anthropicApiKey is provided to the constructor, the
//     "X-Anthropic-Key" header is included on every POST /locate request
//   - When no anthropicApiKey is set, no such header is sent
//   - VisionServiceError is thrown on network failure
//   - VisionServiceError is thrown on non-2xx HTTP status
//   - VisionServiceError is thrown on malformed JSON
//   - assertVisionLocateResponse validates the response shape
//   - healthCheck() returns true on 200, false on error
//
// NOTE: The BYOK tests (X-Anthropic-Key header) will FAIL until Phase 3
// implementation adds the anthropicApiKey option to VisionClient.
// That is intentional — this is the TDD "red" phase.
// ---------------------------------------------------------------------------

const VALID_RESPONSE = {
  found: true,
  bounding_box: { x: 10, y: 20, width: 100, height: 40 },
  confidence: 0.92,
  reasoning: "Found the button in the top-right corner",
  latency_ms: 1300,
};

function makeSuccessfulFetch(body: object = VALID_RESPONSE): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

function makeFailedFetch(status: number, body = "Provider unavailable"): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(body),
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VisionClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Basic HTTP behaviour ─────────────────────────────────────────────────

  it("locate() POSTs to /locate with the correct URL", async () => {
    const fetchMock = makeSuccessfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new VisionClient("http://localhost:8765");
    await client.locate({
      screenshot_base64: "abc",
      description: "login button",
      page_url: "http://example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8765/locate",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("locate() sends Content-Type: application/json header", async () => {
    const fetchMock = makeSuccessfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new VisionClient("http://localhost:8765");
    await client.locate({
      screenshot_base64: "abc",
      description: "btn",
      page_url: "http://x.com",
    });

    const [, options] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("locate() serializes the request body as JSON", async () => {
    const fetchMock = makeSuccessfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new VisionClient("http://localhost:8765");
    await client.locate({
      screenshot_base64: "base64data",
      description: "the search box",
      page_url: "http://example.com/page",
    });

    const [, options] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.screenshot_base64).toBe("base64data");
    expect(body.description).toBe("the search box");
    expect(body.page_url).toBe("http://example.com/page");
  });

  it("locate() strips trailing slash from baseUrl", async () => {
    const fetchMock = makeSuccessfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new VisionClient("http://localhost:8765/");
    await client.locate({ screenshot_base64: "x", description: "y", page_url: "z" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8765/locate",
      expect.anything()
    );
  });

  // ── BYOK: X-Anthropic-Key header ────────────────────────────────────────
  // These tests will FAIL until Phase 3 adds anthropicApiKey to VisionClient.

  it("BYOK: sends X-Anthropic-Key header when anthropicApiKey is provided", async () => {
    const fetchMock = makeSuccessfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new VisionClient("http://localhost:8765", "sk-ant-test-key");
    await client.locate({ screenshot_base64: "x", description: "y", page_url: "z" });

    const [, options] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["X-Anthropic-Key"]).toBe("sk-ant-test-key");
  });

  it("BYOK: does NOT send X-Anthropic-Key header when no key is provided", async () => {
    const fetchMock = makeSuccessfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new VisionClient("http://localhost:8765"); // no key
    await client.locate({ screenshot_base64: "x", description: "y", page_url: "z" });

    const [, options] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["X-Anthropic-Key"]).toBeUndefined();
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it("throws VisionServiceError when fetch rejects (service not running)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    const client = new VisionClient("http://localhost:8765");
    await expect(
      client.locate({ screenshot_base64: "x", description: "y", page_url: "z" })
    ).rejects.toThrow(VisionServiceError);
  });

  it("throws VisionServiceError on 503 response (provider unavailable)", async () => {
    vi.stubGlobal("fetch", makeFailedFetch(503));

    const client = new VisionClient("http://localhost:8765");
    await expect(
      client.locate({ screenshot_base64: "x", description: "y", page_url: "z" })
    ).rejects.toThrow(VisionServiceError);
  });

  it("throws VisionServiceError when response JSON is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
        text: vi.fn().mockResolvedValue("not json"),
      })
    );

    const client = new VisionClient("http://localhost:8765");
    await expect(
      client.locate({ screenshot_base64: "x", description: "y", page_url: "z" })
    ).rejects.toThrow(VisionServiceError);
  });

  it("throws VisionServiceError when response is missing 'found' field", async () => {
    vi.stubGlobal("fetch", makeSuccessfulFetch({ latency_ms: 100 })); // no 'found'

    const client = new VisionClient("http://localhost:8765");
    await expect(
      client.locate({ screenshot_base64: "x", description: "y", page_url: "z" })
    ).rejects.toThrow(VisionServiceError);
  });

  // ── healthCheck ──────────────────────────────────────────────────────────

  it("healthCheck() returns true when service responds 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    const client = new VisionClient("http://localhost:8765");
    expect(await client.healthCheck()).toBe(true);
  });

  it("healthCheck() returns false when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Connection refused"))
    );

    const client = new VisionClient("http://localhost:8765");
    expect(await client.healthCheck()).toBe(false);
  });

  it("healthCheck() returns false when service returns non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 })
    );

    const client = new VisionClient("http://localhost:8765");
    expect(await client.healthCheck()).toBe(false);
  });
});
