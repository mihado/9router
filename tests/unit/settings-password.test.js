import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
    headers: init?.headers || {},
    json: async () => body,
  })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  bcryptCompare: vi.fn(),
  bcryptGenSalt: vi.fn(),
  bcryptHash: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.jsonResponse },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}));

vi.mock("@/shared/services/quotaAutoPing", () => ({
  runQuotaAutoPingTick: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: (...args) => mocks.bcryptCompare(...args),
    genSalt: (...args) => mocks.bcryptGenSalt(...args),
    hash: (...args) => mocks.bcryptHash(...args),
  },
  compare: (...args) => mocks.bcryptCompare(...args),
  genSalt: (...args) => mocks.bcryptGenSalt(...args),
  hash: (...args) => mocks.bcryptHash(...args),
}));

const { PATCH } = await import("../../src/app/api/settings/route.js");

function request(body) {
  return {
    json: async () => body,
    headers: { get: vi.fn(() => null) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateSettings.mockResolvedValue({});
  mocks.bcryptGenSalt.mockResolvedValue("salt");
  mocks.bcryptHash.mockResolvedValue("$2b$10$newhashedpasswordvalue");
});

describe("PATCH /api/settings — first password set", () => {
  describe("with INITIAL_PASSWORD configured", () => {
    beforeEach(() => {
      vi.stubEnv("INITIAL_PASSWORD", "bootstrap-secret");
      mocks.getSettings.mockResolvedValue({});
    });

    it("sets the first password when given correct bootstrap password", async () => {
      mocks.bcryptCompare.mockResolvedValue(true);

      const res = await PATCH(request({
        currentPassword: "bootstrap-secret",
        newPassword: "my-permanent-password",
      }));

      expect(res.status).toBe(200);
      expect(mocks.updateSettings).toHaveBeenCalled();
      const calledWith = mocks.updateSettings.mock.calls[0][0];
      expect(calledWith.password).toBe("$2b$10$newhashedpasswordvalue");
    });

    it("rejects with wrong bootstrap password", async () => {
      const res = await PATCH(request({
        currentPassword: "wrong",
        newPassword: "my-password",
      }));

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid current password");
    });

    it("requires currentPassword for first-time set", async () => {
      const res = await PATCH(request({
        newPassword: "my-password",
      }));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Current password required");
    });
  });

  describe("without INITIAL_PASSWORD configured", () => {
    beforeEach(() => {
      vi.stubEnv("INITIAL_PASSWORD", undefined);
      mocks.getSettings.mockResolvedValue({});
    });

    it("rejects with guidance when INITIAL_PASSWORD is missing", async () => {
      const res = await PATCH(request({
        currentPassword: "anything",
        newPassword: "my-password",
      }));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("INITIAL_PASSWORD not configured");
    });
  });
});

describe("PATCH /api/settings — password change", () => {
  beforeEach(() => {
    mocks.getSettings.mockResolvedValue({
      password: "$2b$10$existinghashvalue",
    });
  });

  it("changes password when given correct current", async () => {
    mocks.bcryptCompare.mockResolvedValue(true);

    const res = await PATCH(request({
      currentPassword: "current-pw",
      newPassword: "new-pw",
    }));

    expect(res.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalled();
  });

  it("rejects with wrong current password", async () => {
    mocks.bcryptCompare.mockResolvedValue(false);

    const res = await PATCH(request({
      currentPassword: "wrong-current",
      newPassword: "new-pw",
    }));

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid current password");
  });

  it("requires currentPassword when a stored hash exists", async () => {
    const res = await PATCH(request({
      newPassword: "new-pw",
    }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Current password required");
  });
});
