import { NextResponse } from "next/server";

// 1. CONFIGURARE TIMEOUT (CRITIC PENTRU A EVITA 502)
export const maxDuration = 60; // Permite funcției să ruleze până la 60 secunde (Vercel)
export const dynamic = "force-dynamic"; // Dezactivează caching-ul static strict

const INTERNAL_KEY = process.env.BETLOGIC_INTERNAL_KEY;
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const INSIGHTS_SCHEMA_VERSION = "2026-01-26-v4-fast"; // Versiune nouă pentru cache

// Cache simplu în memorie
const ANALYSIS_TTL_MS = 10 * 60 * 1000;
const __cache =
  globalThis.__betlogicAnalysisCache ||
  (globalThis.__betlogicAnalysisCache = new Map());

function cacheGet(key) {
  const hit = __cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    __cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs = ANALYSIS_TTL_MS) {
  __cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function withCors(res) {
  const origin = process.env.WP_ORIGIN || "*";
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.headers.set("Access-Control-Allow-Credentials", "true");
  return res;
}

function okJson(payload) {
  const res = NextResponse.json(payload, { status: 200 });
  return withCors(res);
}

function errorJson(payload, status = 502) {
  const res = NextResponse.json(payload, { status });
  return withCors(res);
}

function cleanPlainText(input) {
  if (!input) return "";
  let s = String(input);
  s = s.replace(/```[\s\S]*?```/g, "").replace(/`+/g, "");
  return s.trim();
}

// 2. FUNCTIA OPENAI OPTIMIZATA (Fara Retry, Timeout Lung)
async function callOpenAI(userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, status: 500, error: "Missing API Key" };

  // Forțăm modelul cel mai rapid
  const model = "gpt-4o-mini";

  // Timeout intern setat la 50s (sub limita de 60s a serverului)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50000);

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: userPrompt }],
        temperature: 0.3, // Creativitate scăzută pentru viteză
        max_tokens: 1100, // Destul pentru rezumatul detaliat
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!r.ok) {
      const errText = await r.text();
      console.error("OpenAI Error:", errText);
      return { ok: false, status: r.status, error: "OpenAI API Error" };
    }

    const data = await r.json();
    const rawText = data?.choices?.[0]?.message?.content || "";
    return { ok: true, status: 200, rawText };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("Fetch Error:", err);
    if (err.name === "AbortError") {
      return { ok: false, status: 504, error: "Timeout: AI took too long." };
    }
    return { ok: false, status: 502, error: "Connection failed" };
  }
}

function extractFirstJsonObject(raw) {
  const s = String(raw || "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return s.slice(start, end + 1);
  }
  return null;
}

// --- VALIDARE PAYLOAD ---
function isValidInsightsPayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!obj.probabilities || !obj.teamForm) return false;
  return true; // Validare simplificată pentru viteză
}

// --- HANDLER PRINCIPAL ---
export async function POST(req) {
  // Verificare cheie internă (opțional)
  if (INTERNAL_KEY) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${INTERNAL_KEY}`) {
      return okJson({ error: "Unauthorized" });
    }
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return okJson({ error: "Invalid JSON" });
  }

  const { echipe, liga, status, mode } = body;

  if (!echipe || !liga) {
    return okJson({ error: "Missing data" });
  }

  // Cache Check
  const cacheKey = `${INSIGHTS_SCHEMA_VERSION}|${mode}|${echipe}|${liga}|${status}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return okJson(
      mode === "insights"
        ? { ok: true, insights: cached }
        : { ok: true, analysis: cached }
    );
  }

  // PROMPT PENTRU INSIGHTS (Detaliat)
  const promptInsights = `
  You are a Senior Football Analyst. Return ONLY a single valid JSON object.
  
  INPUT: Match: ${echipe}, Comp: ${liga}, Status: ${status}
  
  GOAL: Provide JSON data for a match dashboard.
  
  CRITICAL:
  - Output ONLY valid JSON. No markdown.
  - "quickSummary" must be EXTENSIVE (8-12 sentences), detailed, tactical, and expert-level.
  
  JSON SCHEMA:
  {
    "probabilities": { "homeWin": int, "draw": int, "awayWin": int }, // Sum 100
    "teamForm": {
      "home": { "series": [int, int, int, int, int] }, // 0-100 values
      "away": { "series": [int, int, int, int, int] }
    },
    "illustrations": {
      "home": { "trend": "up"|"down"|"flat", "volatility": "low"|"medium"|"high", "mood": string, "highlights": [{"label": string, "value": int}] },
      "away": { "trend": "up"|"down"|"flat", "volatility": "low"|"medium"|"high", "mood": string, "highlights": [{"label": string, "value": int}] }
    },
    "quickSummary": string,
    "confidence": int
  }
  `;

  if (String(mode).toLowerCase() === "insights") {
    // 1. Apel OpenAI (O singură încercare)
    let resp = await callOpenAI(promptInsights);

    if (!resp.ok) {
      return errorJson({ error: "AI Busy", details: resp.error }, resp.status);
    }

    // 2. Parse JSON
    const jsonText = extractFirstJsonObject(resp.rawText);
    let insights;
    try {
      insights = JSON.parse(jsonText);
    } catch (e) {
      return errorJson({ error: "Invalid AI JSON", raw: resp.rawText }, 500);
    }

    // 3. Validare sumară și Normalizare
    if (!isValidInsightsPayload(insights)) {
      // Fallback simplu dacă AI-ul greșește structura, ca să nu dăm 502
      insights = {
        probabilities: { home: 33, draw: 34, away: 33 },
        quickSummary: "Data generation incomplete. Please try again.",
        ...insights,
      };
    }

    // Normalizare chei pentru frontend
    if (insights.probabilities) {
      const p = insights.probabilities;
      insights.probabilities.home = p.homeWin ?? p.home ?? 33;
      insights.probabilities.draw = p.draw ?? 34;
      insights.probabilities.away = p.awayWin ?? p.away ?? 33;
    }

    cacheSet(cacheKey, insights);
    return okJson({ ok: true, insights });
  }

  // Fallback pentru alte moduri (dacă există)
  return okJson({ error: "Invalid mode" });
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  return withCors(res);
}
