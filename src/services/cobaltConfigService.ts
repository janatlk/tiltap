import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

const CONFIG_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(CONFIG_DIR, "cobalt-config.json");

const DEFAULT_TEST_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// Mirror of DEFAULT_COBALT_APIS in youtube_cobalt.py. Kept in sync so the Node
// health monitor probes exactly the instances the Python downloader would use.
const DEFAULT_COBALT_URLS = [
  "https://api.cobalt.liubquanti.click/",
  "https://co.otomir23.me/",
  "https://cobalt-backend.canine.tools/",
];

interface CobaltConfig {
  urls: string[];
}

let cachedUrls: string[] | null = null;

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().replace(/\/$/, "") + "/";
  } catch {
    return null;
  }
}

function loadConfigFile(): CobaltConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { urls: [] };
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as CobaltConfig;
    return { urls: Array.isArray(data.urls) ? data.urls : [] };
  } catch (err) {
    logger.error("Failed to load cobalt config", { error: err instanceof Error ? err.message : String(err) });
    return { urls: [] };
  }
}

function saveConfigFile(config: CobaltConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    logger.error("Failed to save cobalt config", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export function getConfiguredCobaltUrls(): string[] {
  if (cachedUrls === null) {
    cachedUrls = loadConfigFile().urls;
  }
  return cachedUrls;
}

export function setConfiguredCobaltUrls(urls: string[]): string[] {
  const normalized = urls.map(normalizeUrl).filter((u): u is string => u !== null);
  const unique = Array.from(new Set(normalized));
  cachedUrls = unique;
  saveConfigFile({ urls: unique });
  return unique;
}

export function resetConfiguredCobaltUrls(): void {
  cachedUrls = [];
  saveConfigFile({ urls: [] });
}

/**
 * Build the value for the COBALT_API_URLS environment variable passed to
 * Python download/validation scripts. Configured URLs take priority over
 * defaults so admins can override broken instances without redeploying.
 */
export function getCobaltApiUrlsEnv(): string {
  const configured = getConfiguredCobaltUrls();
  return configured.join(",");
}

/**
 * Resolve the Cobalt instances actually in effect, mirroring the priority in
 * youtube_cobalt.py: admin-panel config → COBALT_API_URLS → COBALT_API_URL →
 * built-in defaults. Used by the health monitor so it probes the same list the
 * Python downloader will use.
 */
export function getEffectiveCobaltUrls(): string[] {
  const configured = getConfiguredCobaltUrls();
  if (configured.length > 0) return configured;

  const envList = (process.env.COBALT_API_URLS || "")
    .split(",")
    .map((u) => normalizeUrl(u))
    .filter((u): u is string => u !== null);
  if (envList.length > 0) return envList;

  const single = normalizeUrl(process.env.COBALT_API_URL || "");
  if (single) return [single];

  return DEFAULT_COBALT_URLS;
}

export interface CobaltTestResult {
  ok: boolean;
  status?: string;
  error?: string;
  latencyMs: number;
  /** Bytes pulled from the tunnel during the probe. */
  probedBytes?: number;
}

/** Enough to tell a real stream from an instance that answers with nothing. */
const TUNNEL_PROBE_BYTES = 16 * 1024;

/**
 * Read a few KB from a tunnel URL and stop. An instance whose YouTube access is
 * blocked still hands out a tunnel and then closes it with an empty 200, so
 * resolving proves nothing — only bytes do.
 */
async function probeTunnel(tunnelUrl: string): Promise<number> {
  const resp = await fetch(tunnelUrl, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok || !resp.body) return 0;

  const reader = resp.body.getReader();
  let received = 0;
  try {
    while (received < TUNNEL_PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.length ?? 0;
    }
  } finally {
    // Never drain the whole file: a probe must stay cheap.
    await reader.cancel().catch(() => {});
  }
  return received;
}

export async function testCobaltApiUrl(apiUrl: string, testUrl?: string): Promise<CobaltTestResult> {
  const normalized = normalizeUrl(apiUrl);
  if (!normalized) {
    return { ok: false, error: "Invalid URL", latencyMs: 0 };
  }

  const target = testUrl || DEFAULT_TEST_URL;
  const start = Date.now();
  try {
    const resp = await fetch(normalized, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ url: target, downloadMode: "audio" }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json() as { status?: string; error?: { code?: string }; url?: string };
    const latencyMs = Date.now() - start;

    if (resp.ok && (data.status === "tunnel" || data.status === "redirect")) {
      if (!data.url) {
        return { ok: false, status: data.status, error: "no tunnel url", latencyMs };
      }
      let probedBytes = 0;
      try {
        probedBytes = await probeTunnel(data.url);
      } catch (err) {
        return {
          ok: false,
          status: data.status,
          error: `tunnel unreachable: ${err instanceof Error ? err.message : String(err)}`,
          latencyMs: Date.now() - start,
        };
      }
      if (probedBytes === 0) {
        // The exact failure that used to read as "healthy" in the panel while
        // every download through this instance came back empty.
        return { ok: false, status: data.status, error: "tunnel returned no data", latencyMs: Date.now() - start, probedBytes };
      }
      return { ok: true, status: data.status, latencyMs: Date.now() - start, probedBytes };
    }

    return {
      ok: false,
      status: data.status,
      error: data.error?.code || `HTTP ${resp.status}`,
      latencyMs,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}
