import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

const CONFIG_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(CONFIG_DIR, "cobalt-config.json");

const DEFAULT_TEST_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

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

export interface CobaltTestResult {
  ok: boolean;
  status?: string;
  error?: string;
  latencyMs: number;
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
    const data = await resp.json() as { status?: string; error?: { code?: string } };
    const latencyMs = Date.now() - start;

    if (resp.ok && (data.status === "tunnel" || data.status === "redirect")) {
      return { ok: true, status: data.status, latencyMs };
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
