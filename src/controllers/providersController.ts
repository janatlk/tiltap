import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { config } from "../config";
import { logger } from "../utils/logger";

interface ProviderStatus {
  configured: boolean;
  status: "ok" | "error" | "unknown";
  details?: Record<string, unknown>;
  error?: string;
}

interface ProvidersHealthResponse {
  timestamp: string;
  providers: Record<string, ProviderStatus>;
}

const REQUEST_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

function startOfMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function endOfMonth(date: Date): string {
  const y = date.getFullYear();
  const m = date.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${lastDay}`;
}

async function checkElevenLabs(): Promise<ProviderStatus> {
  if (!config.ELEVENLABS_API_KEY) {
    return { configured: false, status: "unknown" };
  }

  const headers = { "xi-api-key": config.ELEVENLABS_API_KEY };

  try {
    // Try the subscription endpoint first — it gives quota, invoices and next billing.
    const subRes = await fetchWithTimeout("https://api.elevenlabs.io/v1/user/subscription", {
      headers,
    });

    if (subRes.ok) {
      const data = (await subRes.json()) as Record<string, unknown>;
      const nextInvoice = data.next_invoice as Record<string, unknown> | undefined;
      const openInvoices = data.open_invoices as Array<Record<string, unknown>> | undefined;
      const overage = data.current_overage as Record<string, unknown> | undefined;

      return {
        configured: true,
        status: "ok",
        details: {
          tier: data.tier,
          status: data.status,
          characterCount: data.character_count,
          characterLimit: data.character_limit,
          creditsRemaining:
            typeof data.character_count === "number" && typeof data.character_limit === "number"
              ? Math.max(0, data.character_limit - data.character_count)
              : undefined,
          nextResetAt: data.next_character_count_reset_unix
            ? new Date((data.next_character_count_reset_unix as number) * 1000).toISOString()
            : undefined,
          currency: data.currency,
          billingPeriod: data.billing_period,
          currentOverage: overage,
          amountDue: nextInvoice?.amount_due ?? openInvoices?.[0]?.amount_due,
          nextInvoiceDate: nextInvoice?.date ?? openInvoices?.[0]?.date,
        },
      };
    }

    const subBody = await subRes.text();
    let subDetail: Record<string, unknown> | undefined;
    try {
      subDetail = JSON.parse(subBody).detail as Record<string, unknown>;
    } catch {
      // ignore
    }

    // The API key exists but does not have the "user_read" permission.
    // We still treat the provider as functional, but cannot show quota/billing.
    if (subRes.status === 401 && subDetail?.status === "missing_permissions") {
      return {
        configured: true,
        status: "ok",
        details: {
          keyPresent: true,
          billingUnavailableReason:
            "The API key is missing the 'user_read' permission. Create a key with that permission at https://elevenlabs.io/app/settings/api-keys to see quota, amount due and next invoice.",
        },
      };
    }

    return { configured: true, status: "error", error: `HTTP ${subRes.status}: ${subBody}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { configured: true, status: "error", error: msg };
  }
}

async function checkOpenAI(): Promise<ProviderStatus> {
  if (!config.OPENAI_API_KEY) {
    return { configured: false, status: "unknown" };
  }

  const headers = { Authorization: `Bearer ${config.OPENAI_API_KEY}` };
  const details: Record<string, unknown> = {
    billingNote:
      "OpenAI billing endpoints require a browser session key. Check quota and invoices at https://platform.openai.com/account/usage.",
  };

  try {
    // Validate the secret key by listing models.
    const modelsRes = await fetchWithTimeout("https://api.openai.com/v1/models", { headers });
    if (!modelsRes.ok) {
      const body = await modelsRes.text();
      return { configured: true, status: "error", error: `HTTP ${modelsRes.status}: ${body}` };
    }

    // Try billing endpoints anyway; for some org/admin keys they work.
    const [subRes, creditRes] = await Promise.all([
      fetchWithTimeout("https://api.openai.com/v1/dashboard/billing/subscription", { headers }),
      fetchWithTimeout("https://api.openai.com/v1/dashboard/billing/credit_grants", { headers }),
    ]);

    if (subRes.ok) {
      const sub = (await subRes.json()) as Record<string, unknown>;
      details.plan = sub.plan ?? sub.object;
      details.softLimitUsd = sub.soft_limit_usd;
      details.hardLimitUsd = sub.hard_limit_usd;
      details.systemHardLimitUsd = sub.system_hard_limit_usd;
      details.accessUntil = sub.access_until
        ? new Date((sub.access_until as number) * 1000).toISOString()
        : undefined;
      details.nextChargeDate = details.accessUntil;
    } else {
      details.subscriptionError = `HTTP ${subRes.status}: ${await subRes.text()}`;
    }

    if (creditRes.ok) {
      const credits = (await creditRes.json()) as Record<string, unknown>;
      details.totalGranted = credits.total_granted;
      details.totalUsed = credits.total_used;
      details.totalAvailable = credits.total_available;
    } else {
      details.creditsError = `HTTP ${creditRes.status}: ${await creditRes.text()}`;
    }

    // Current month usage.
    try {
      const now = new Date();
      const usageUrl = `https://api.openai.com/v1/usage?start_date=${startOfMonth(now)}&end_date=${endOfMonth(now)}`;
      const usageRes = await fetchWithTimeout(usageUrl, { headers });
      if (usageRes.ok) {
        const usage = (await usageRes.json()) as Record<string, unknown>;
        details.currentMonthUsageUsd =
          typeof usage.total_usage === "number" ? usage.total_usage / 100 : usage.total_usage;
      }
    } catch {
      // Ignore usage fetch failures.
    }

    // The secret key itself is valid; billing endpoints may require a browser session key.
    return {
      configured: true,
      status: "ok",
      details,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { configured: true, status: "error", error: msg };
  }
}

async function checkGroq(): Promise<ProviderStatus> {
  if (!config.GROQ_API_KEY) {
    return { configured: false, status: "unknown" };
  }

  try {
    const res = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` },
    });

    if (!res.ok) {
      const body = await res.text();
      return { configured: true, status: "error", error: `HTTP ${res.status}: ${body}` };
    }

    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return {
      configured: true,
      status: "ok",
      details: {
        availableModels: data.data?.map((m) => m.id) ?? [],
        billingNote: "Groq does not expose a billing API; check usage at https://console.groq.com/",
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { configured: true, status: "error", error: msg };
  }
}

async function checkGemini(): Promise<ProviderStatus> {
  if (!config.GEMINI_API_KEY) {
    return { configured: false, status: "unknown" };
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.GEMINI_API_KEY}`;
    const res = await fetchWithTimeout(url, { method: "GET" });

    if (!res.ok) {
      const body = await res.text();
      return { configured: true, status: "error", error: `HTTP ${res.status}: ${body}` };
    }

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return {
      configured: true,
      status: "ok",
      details: {
        availableModels: data.models?.map((m) => m.name) ?? [],
        billingNote: "Gemini does not expose a billing API; check quota at https://ai.google.dev/",
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { configured: true, status: "error", error: msg };
  }
}

async function checkLingva(): Promise<ProviderStatus> {
  if (!config.LINGVA_TRANSLATE_URL) {
    return { configured: false, status: "unknown" };
  }

  try {
    const baseUrl = config.LINGVA_TRANSLATE_URL.replace(/\/$/, "");
    const res = await fetchWithTimeout(`${baseUrl}/api/v1/en/ru/hello`, { method: "GET" });

    if (!res.ok) {
      const body = await res.text();
      return { configured: true, status: "error", error: `HTTP ${res.status}: ${body}` };
    }

    return {
      configured: true,
      status: "ok",
      details: {
        url: config.LINGVA_TRANSLATE_URL,
        billingNote: "Free provider — no billing information available.",
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { configured: true, status: "error", error: msg };
  }
}

export async function getProvidersHealth(_req: ExpressRequest, res: ExpressResponse): Promise<void> {
  const [elevenlabs, openai, groq, gemini, lingva] = await Promise.all([
    checkElevenLabs(),
    checkOpenAI(),
    checkGroq(),
    checkGemini(),
    checkLingva(),
  ]);

  const response: ProvidersHealthResponse = {
    timestamp: new Date().toISOString(),
    providers: {
      elevenlabs,
      openai,
      groq,
      gemini,
      lingva,
    },
  };

  const anyCriticalError = Object.values(response.providers).some(
    (p) => p.configured && p.status === "error" && !p.details?.billingUnavailableReason
  );

  logger.info("Providers health checked", {
    anyError: anyCriticalError,
    elevenlabsStatus: elevenlabs.status,
    openaiStatus: openai.status,
  });

  res.status(200).json(response);
}
