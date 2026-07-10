import { describe, it, expect } from "vitest";
import { resolveBaseUrl } from "../../open-sse/handlers/search/callers.js";

const config = { id: "searxng", baseUrl: "http://searxng:8080/search" };

describe("search provider baseUrl SSRF guard (Finding #14)", () => {
  it("returns the configured default when no override is given", () => {
    expect(resolveBaseUrl(config, {})).toBe("http://searxng:8080/search");
  });

  it("does not SSRF-check the operator-configured default", () => {
    // Self-hosted SearXNG legitimately lives on a private address.
    const privateConfig = { id: "searxng", baseUrl: "http://192.168.1.50:8080/search" };
    expect(resolveBaseUrl(privateConfig, {})).toBe("http://192.168.1.50:8080/search");
  });

  it("allows a public override URL via providerOptions.baseUrl", () => {
    const params = { providerOptions: { baseUrl: "https://searx.example.com/search" } };
    expect(resolveBaseUrl(config, params)).toBe("https://searx.example.com/search");
  });

  it("allows a public override URL via providerSpecificData.baseUrl", () => {
    const params = { providerSpecificData: { baseUrl: "https://searx.example.com/search" } };
    expect(resolveBaseUrl(config, params)).toBe("https://searx.example.com/search");
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/search",
    "http://localhost:8080/search",
    "http://10.0.0.5/search",
    "http://192.168.1.1/search",
  ])("rejects a caller-supplied override pointing at %s", (url) => {
    const params = { providerOptions: { baseUrl: url } };
    expect(() => resolveBaseUrl(config, params)).toThrow();
  });
});
