import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
    headers: init?.headers || {},
    json: async () => body,
  })),
  getSettings: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  isOidcConfigured: vi.fn(),
  checkLock: vi.fn(),
  recordFail: vi.fn(),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(),
  bcryptCompare: vi.fn(),
  mockCookies: { set: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.jsonResponse },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: mocks.isOidcConfigured,
}));

vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
}));

vi.mock("bcryptjs", () => ({
  default: { compare: (...args) => mocks.bcryptCompare(...args) },
  compare: (...args) => mocks.bcryptCompare(...args),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.mockCookies),
}));

const { POST } = await import("../../src/app/api/auth/login/route.js");

function request(body) {
  return {
    json: async () => body,
    headers: { get: vi.fn(() => null) },
    cookies: { get: vi.fn(() => undefined) },
    url: "http://localhost:20128/api/auth/login",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClientIp.mockReturnValue("127.0.0.1");
  mocks.checkLock.mockReturnValue({ locked: false });
  mocks.recordFail.mockReturnValue({ remainingBeforeLock: 4 });
  mocks.isOidcConfigured.mockReturnValue(false);
  mocks.getSettings.mockResolvedValue({ authMode: "password" });
});

describe("POST /api/auth/login", () => {
  describe("no stored hash", () => {
    beforeEach(() => {
      mocks.getSettings.mockResolvedValue({ authMode: "password" });
      vi.stubEnv("INITIAL_PASSWORD", "bootstrap-secret");
    });

    it("accepts the correct bootstrap password", async () => {
      const res = await POST(request({ password: "bootstrap-secret" }));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mustChangePassword).toBe(true);
      expect(res.body.mustChangeHint).toContain("bootstrap password");
    });

    it("returns mustChangeHint with the success response", async () => {
      const res = await POST(request({ password: "bootstrap-secret" }));

      expect(res.body.mustChangeHint).toBeDefined();
      expect(res.body.mustChangeHint.length).toBeGreaterThan(10);
    });

    it("rejects a wrong bootstrap password", async () => {
      const res = await POST(request({ password: "wrong" }));

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid password");
    });

    it("records a failure on wrong password", async () => {
      await POST(request({ password: "wrong" }));

      expect(mocks.recordFail).toHaveBeenCalled();
    });
  });

  describe("no stored hash, no INITIAL_PASSWORD", () => {
    beforeEach(() => {
      mocks.getSettings.mockResolvedValue({ authMode: "password" });
      vi.stubEnv("INITIAL_PASSWORD", undefined);
    });

    it("returns 500 with guidance", async () => {
      const res = await POST(request({ password: "anything" }));

      expect(res.status).toBe(500);
      expect(res.body.error).toContain("INITIAL_PASSWORD");
      expect(res.body.error).toContain("bootstrap password");
    });
  });

  describe("stored hash present", () => {
    beforeEach(() => {
      vi.stubEnv("INITIAL_PASSWORD", undefined);
      mocks.getSettings.mockResolvedValue({
        authMode: "password",
        password: "$2b$10$hashedstoredpasswordvalue",
      });
    });

    it("accepts a correct stored password", async () => {
      mocks.bcryptCompare.mockResolvedValue(true);

      const res = await POST(request({ password: "my-stored-pw" }));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mustChangePassword).toBe(false);
      expect(res.body.mustChangeHint).toBeUndefined();
    });

    it("rejects a wrong stored password", async () => {
      mocks.bcryptCompare.mockResolvedValue(false);

      const res = await POST(request({ password: "wrong-stored-pw" }));

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid password");
    });
  });

  describe("OIDC mode", () => {
    beforeEach(() => {
      mocks.getSettings.mockResolvedValue({ authMode: "oidc" });
      mocks.isOidcConfigured.mockReturnValue(true);
    });

    it("blocks password login when OIDC is configured", async () => {
      const res = await POST(request({ password: "pw" }));

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("OIDC");
    });
  });

  describe("rate limiting", () => {
    it("returns 429 when locked", async () => {
      mocks.checkLock.mockReturnValue({ locked: true, retryAfter: 30 });

      const res = await POST(request({ password: "pw" }));

      expect(res.status).toBe(429);
      expect(res.body.retryAfter).toBe(30);
      expect(res.body.resetHint).toContain("INITIAL_PASSWORD");
    });
  });
});
