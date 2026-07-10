/**
 * Tests for the disabledFreeProviders toggle in getProviderCredentials.
 *
 * When a noAuth free provider (mimo-free, opencode) is listed in
 * settings.disabledFreeProviders, getProviderCredentials must return null
 * instead of injecting the virtual "noauth" connection. When the list is
 * absent or does not include the provider, it should still return the
 * virtual connection as before.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

const PROXY_DEFAULTS = {
  connectionProxyEnabled: false,
  connectionProxyUrl: "",
  connectionNoProxy: "",
  proxyPoolId: null,
  vercelRelayUrl: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConnectionProxyConfig.mockResolvedValue(PROXY_DEFAULTS);
  mocks.getProviderConnections.mockResolvedValue([]);
});

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

describe("getProviderCredentials — noAuth free providers", () => {
  it("returns the virtual noauth connection when disabledFreeProviders is absent", async () => {
    mocks.getSettings.mockResolvedValue({});

    const creds = await getProviderCredentials("mimo-free");

    expect(creds).not.toBeNull();
    expect(creds.id).toBe("noauth");
    expect(creds.isActive).toBe(true);
    expect(creds.accessToken).toBe("public");
  });

  it("returns the virtual noauth connection when disabledFreeProviders is empty", async () => {
    mocks.getSettings.mockResolvedValue({ disabledFreeProviders: [] });

    const creds = await getProviderCredentials("mimo-free");

    expect(creds).not.toBeNull();
    expect(creds.id).toBe("noauth");
  });

  it("returns null when mimo-free is in disabledFreeProviders", async () => {
    mocks.getSettings.mockResolvedValue({ disabledFreeProviders: ["mimo-free"] });

    const creds = await getProviderCredentials("mimo-free");

    expect(creds).toBeNull();
  });

  it("returns null when opencode is in disabledFreeProviders", async () => {
    mocks.getSettings.mockResolvedValue({ disabledFreeProviders: ["opencode"] });

    const creds = await getProviderCredentials("opencode");

    expect(creds).toBeNull();
  });

  it("disabling one provider does not affect another", async () => {
    mocks.getSettings.mockResolvedValue({ disabledFreeProviders: ["mimo-free"] });

    const creds = await getProviderCredentials("opencode");

    expect(creds).not.toBeNull();
    expect(creds.id).toBe("noauth");
  });

  it("re-enables when removed from disabledFreeProviders", async () => {
    mocks.getSettings.mockResolvedValueOnce({ disabledFreeProviders: ["mimo-free"] });
    expect(await getProviderCredentials("mimo-free")).toBeNull();

    mocks.getSettings.mockResolvedValueOnce({ disabledFreeProviders: [] });
    const creds = await getProviderCredentials("mimo-free");
    expect(creds).not.toBeNull();
    expect(creds.id).toBe("noauth");
  });

  it("resolves the mmf alias to mimo-free and applies the disabled check", async () => {
    mocks.getSettings.mockResolvedValue({ disabledFreeProviders: ["mimo-free"] });

    const creds = await getProviderCredentials("mmf");

    expect(creds).toBeNull();
  });
});

describe("getProviderCredentials — non-noAuth providers are unaffected", () => {
  it("does not apply disabledFreeProviders to an apikey provider", async () => {
    mocks.getSettings.mockResolvedValue({ disabledFreeProviders: ["openai"] });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", authType: "apikey", testStatus: "active", isActive: true },
    ]);

    // openai is not a noAuth free provider — the disabled list must be ignored
    const creds = await getProviderCredentials("openai");

    expect(creds).not.toBeNull();
    expect(creds.connectionId).toBe("conn-1");
  });
});
