import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { cleanupProviderConnections, getSettings, updateSettings, getApiKeys } from "@/lib/localDb";
import { getMitmStatus, startMitm, loadEncryptedPassword, initDbHooks } from "@/mitm/manager";
import { startQuotaAutoPing } from "@/shared/services/quotaAutoPing";
import { syncToJson as syncMitmAliasCache } from "@/lib/mitmAliasCache";

(function bootstrapMitm() {
  if (!process.env.MITM_SERVER_PATH) {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const appSrc = dirname(dirname(thisFile));
      const candidate = join(appSrc, "mitm", "server.js");
      if (existsSync(candidate)) process.env.MITM_SERVER_PATH = candidate;
    } catch { /* ignore */ }
  }
  try { initDbHooks(getSettings, updateSettings); } catch { /* ignore */ }
})();

const g = global.__appSingleton ??= {
  mitmStartInProgress: false,
};

export async function initializeApp() {
  try {
    await cleanupProviderConnections();
    const settings = await getSettings();

    syncMitmAliasCache().catch(() => {});
    autoStartMitm();
    startQuotaAutoPing();
  } catch (error) {
    console.error("[InitApp] Error:", error);
  }
}

async function autoStartMitm() {
  if (g.mitmStartInProgress) return;
  g.mitmStartInProgress = true;
  try {
    const settings = await getSettings();
    if (!settings.mitmEnabled) return;
    const mitmStatus = await getMitmStatus();
    if (mitmStatus.running) return;

    const password = await loadEncryptedPassword();
    if (!password && process.platform !== "win32") {
      console.log("[InitApp] MITM was enabled but no saved password found, skipping auto-start");
      return;
    }

    const keys = await getApiKeys();
    const activeKey = keys.find(k => k.isActive !== false);

    console.log("[InitApp] MITM was enabled, auto-starting...");
    await startMitm(activeKey?.key || "sk_9router", password);
    console.log("[InitApp] MITM auto-started");
  } catch (err) {
    console.log("[InitApp] MITM auto-start failed:", err.message);
  } finally {
    g.mitmStartInProgress = false;
  }
}

export default initializeApp;
