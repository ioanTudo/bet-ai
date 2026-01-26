import { NextResponse } from "next/server";

const INTERNAL_KEY = process.env.BETLOGIC_INTERNAL_KEY;
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
// Bump this when you change the insights schema/prompt so cached payloads don't keep old shapes.
const INSIGHTS_SCHEMA_VERSION = "2026-01-26-v3";

// Simple in-memory cache (best-effort). Helps performance and reduces 502s from upstream.
// Note: Vercel/serverless may evict between invocations; still useful under load.
const ANALYSIS_TTL_MS = 10 * 60 * 1000; // 10 minutes
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
  res.headers.set("Cache-Control", "no-store");
  return withCors(res);
}

function errorJson(payload, status = 502) {
  const res = NextResponse.json(payload, { status });
  res.headers.set("Cache-Control", "no-store");
  return withCors(res);
}

function cleanPlainText(input) {
  if (!input) return "";
  let s = String(input);

  // Remove common markdown tokens and formatting artifacts
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`+/g, "");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s*>\s?/gm, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/^\s*[-•]\s+/gm, "");
  s = s.replace(/\[(.*?)\]\((.*?)\)/g, "$1");

  // Normalize whitespace
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  return s;
}

function looksLikeCodeOrMarkup(text) {
  const s = String(text || "");
  if (!s.trim()) return false;

  // HTML/XML-ish
  if (/<\/?[a-z][\s\S]*?>/i.test(s)) return true;

  // Markdown fences
  if (/```[\s\S]*?```/.test(s)) return true;

  // Common JS/code signals
  if (/(^|\n)\s*(import|export)\s+/m.test(s)) return true;
  if (/(^|\n)\s*(const|let|var)\s+\w+/m.test(s)) return true;
  if (/\bfunction\b\s*\w*\s*\(/.test(s)) return true;
  if (/=>\s*\{?/.test(s)) return true;

  // JSON-ish (avoid rejecting normal text that mentions braces once)
  const bracePairs =
    (s.match(/\{/g) || []).length + (s.match(/\}/g) || []).length;
  if (bracePairs >= 4 && /"\s*:\s*/.test(s)) return true;

  return false;
}

function extractFirstJsonObject(raw) {
  const s = String(raw || "").trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  // Find a matching closing brace using a simple brace counter
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

function normTeamName(x) {
  return String(x || "")
    .toLowerCase()
    .replace(/\b(fc|cf|sc|ac|afc|cfc)\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickCompetitionCodeFromLiga(liga) {
  const s = String(liga || "").toLowerCase();
  // Keep this small + safe. Extend as needed.
  if (
    s.includes("premier league") ||
    (s.includes("england") && s.includes("prem"))
  )
    return "PL";
  if (s.includes("la liga") || (s.includes("spain") && s.includes("liga")))
    return "PD";
  if (s.includes("serie a") || (s.includes("italy") && s.includes("serie")))
    return "SA";
  if (s.includes("bundesliga") || s.includes("germany")) return "BL1";
  if (s.includes("ligue 1") || s.includes("france")) return "FL1";
  if (s.includes("champions league") || s.includes("uefa champions"))
    return "CL";
  if (s.includes("europa league") || s.includes("uefa europa")) return "EL";
  return null;
}

async function fdFetch(path, { signal } = {}) {
  if (!FOOTBALL_DATA_KEY)
    return {
      ok: false,
      status: 500,
      data: null,
      error: "Missing FOOTBALL_DATA_API_KEY",
    };
  const url = `${FOOTBALL_DATA_BASE}${path}`;
  try {
    const r = await fetch(url, {
      headers: { "X-Auth-Token": FOOTBALL_DATA_KEY },
      signal,
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return {
        ok: false,
        status: r.status || 502,
        data,
        error: data?.message || "football-data error",
      };
    }
    return { ok: true, status: 200, data, error: null };
  } catch (e) {
    return {
      ok: false,
      status: 502,
      data: null,
      error: String(e?.message || e),
    };
  }
}

async function getCompetitionTeams(code, { signal } = {}) {
  if (!code) return null;
  const r = await fdFetch(`/competitions/${encodeURIComponent(code)}/teams`, {
    signal,
  });
  if (!r.ok) return null;
  const teams = Array.isArray(r.data?.teams) ? r.data.teams : [];
  return teams;
}

function bestTeamMatchByName(teams, targetName) {
  const t = normTeamName(targetName);
  if (!t || !Array.isArray(teams) || !teams.length) return null;

  // 1) exact normalized match
  let hit = teams.find((x) => normTeamName(x?.name) === t);
  if (hit) return hit;

  // 2) includes match
  hit = teams.find((x) => {
    const n = normTeamName(x?.name);
    return n && (n.includes(t) || t.includes(n));
  });
  if (hit) return hit;

  // 3) token overlap score
  const tt = new Set(t.split(" ").filter(Boolean));
  let best = null;
  let bestScore = 0;
  for (const x of teams) {
    const n = normTeamName(x?.name);
    if (!n) continue;
    const nt = new Set(n.split(" ").filter(Boolean));
    let score = 0;
    for (const w of tt) if (nt.has(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = x;
    }
  }
  return bestScore >= 1 ? best : null;
}

async function getTeamSquad(teamId, { signal } = {}) {
  if (!teamId) return null;
  const r = await fdFetch(`/teams/${encodeURIComponent(teamId)}`, { signal });
  if (!r.ok) return null;
  const squad = Array.isArray(r.data?.squad) ? r.data.squad : [];
  // keep only essential fields
  return squad
    .map((p) => ({
      name: p?.name || "",
      position: p?.position || "",
      nationality: p?.nationality || "",
    }))
    .filter((p) => p.name && String(p.name).trim().length >= 2);
}

function safeSquadListForPrompt(squad) {
  const arr = Array.isArray(squad) ? squad : [];
  // Limit prompt size
  const top = arr.slice(0, 26);
  return top
    .map((p) => ({ name: p.name, position: p.position }))
    .filter((p) => p.name);
}

function isValidInsightsPayload(obj) {
  if (!obj || typeof obj !== "object") return false;

  // --- probabilities ---
  const p = obj?.probabilities;
  if (!p || typeof p !== "object") return false;

  // Accept either {homeWin, draw, awayWin} or aliases {home, draw, away}
  const hw = Number(p.homeWin ?? p.home ?? p.h);
  const dr = Number(p.draw ?? p.d);
  const aw = Number(p.awayWin ?? p.away ?? p.a);

  if (![hw, dr, aw].every((n) => Number.isFinite(n))) return false;

  // Must be integers and sum EXACTLY 100
  if (![hw, dr, aw].every((n) => Number.isInteger(n))) return false;
  const sum = hw + dr + aw;
  if (sum !== 100) return false;
  if ([hw, dr, aw].some((n) => n < 0 || n > 100)) return false;

  // --- team form series ---
  const tf = obj?.teamForm;
  if (!tf || typeof tf !== "object") return false;

  const home = tf?.home;
  const away = tf?.away;
  const homeSeries = home?.series;
  const awaySeries = away?.series;

  if (!home || typeof home !== "object") return false;
  if (!away || typeof away !== "object") return false;
  if (typeof home.label !== "string") return false;
  if (typeof away.label !== "string") return false;

  if (!Array.isArray(homeSeries) || !Array.isArray(awaySeries)) return false;
  if (homeSeries.length < 5 || awaySeries.length < 5) return false;

  const okSeries = (arr) =>
    arr.every(
      (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100
    );

  if (!okSeries(homeSeries) || !okSeries(awaySeries)) return false;

  // --- illustrations (optional) ---
  const ill = obj?.illustrations;
  const allowedTrend = new Set(["up", "down", "flat"]);
  const allowedVol = new Set(["low", "medium", "high"]);
  const allowedMood = new Set(["confident", "balanced", "unstable"]);

  const checkHighlights = (arr) => {
    if (!Array.isArray(arr)) return false;
    if (arr.length > 4) return false;
    return arr.every((h) => {
      if (!h || typeof h !== "object") return false;
      if (typeof h.label !== "string" || !h.label.trim()) return false;
      const v = Number(h.value);
      const idx = Number(h.index);
      if (!Number.isFinite(v) || v < 0 || v > 100) return false;
      if (!Number.isFinite(idx) || !Number.isInteger(idx) || idx < 0)
        return false;
      return true;
    });
  };

  const checkIll = (x) => {
    if (x == null) return true;
    if (typeof x !== "object") return false;
    if (!allowedTrend.has(String(x.trend))) return false;
    if (!allowedVol.has(String(x.volatility))) return false;
    if (!allowedMood.has(String(x.mood))) return false;
    if (typeof x.summary !== "string" || x.summary.trim().length < 5)
      return false;
    if (!checkHighlights(x.highlights || [])) return false;
    return true;
  };

  if (ill != null) {
    if (typeof ill !== "object") return false;
    if (!checkIll(ill?.home)) return false;
    if (!checkIll(ill?.away)) return false;
  }

  // --- quickSummary (required) ---
  if (typeof obj?.quickSummary !== "string") return false;
  const qs = obj.quickSummary.trim();
  // keep it short-ish and useful
  if (qs.length < 20 || qs.length > 420) return false;

  const ci = Number(obj?.confidence);
  if (!Number.isFinite(ci) || !Number.isInteger(ci) || ci < 0 || ci > 100)
    return false;

  if (obj?.notes != null && typeof obj.notes !== "string") return false;

  return true;
}

function isValidAnalysisText(raw) {
  if (!raw) return false;
  const s = String(raw).trim();
  if (!s) return false;
  if (looksLikeCodeOrMarkup(s)) return false;

  // Accept either 1) or 1. for headings (models sometimes vary)
  const hasNumbered1 = /(^|\n)\s*1[\)\.]\s+/.test(s);
  const hasNumbered2 = /(^|\n)\s*2[\)\.]\s+/.test(s);
  const hasNumbered3 = /(^|\n)\s*3[\)\.]\s+/.test(s);
  const hasNumbered4 = /(^|\n)\s*4[\)\.]\s+/.test(s);
  const hasNumbered5 = /(^|\n)\s*5[\)\.]\s+/.test(s);

  // Must include the main sections, but be tolerant about wording
  const hasMain =
    hasNumbered1 &&
    hasNumbered2 &&
    hasNumbered3 &&
    hasNumbered4 &&
    hasNumbered5;

  // We still prefer seeing scenario/uncertainty cues somewhere
  const hasScenarioCue = /scenari/i.test(s) || /alternativ/i.test(s);
  const hasUncertaintyCue = /incertitud/i.test(s) || /risc/i.test(s);

  return hasMain && (hasScenarioCue || hasUncertaintyCue);
}

function endsWithSentencePunctuation(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  return /[.!?…]$/.test(s);
}

function hasAllMainSections(text) {
  const s = String(text || "");
  // Accept either 1) or 1. for headings
  return (
    /(^|\n)\s*1[\)\.]\s+/.test(s) &&
    /(^|\n)\s*2[\)\.]\s+/.test(s) &&
    /(^|\n)\s*3[\)\.]\s+/.test(s) &&
    /(^|\n)\s*4[\)\.]\s+/.test(s) &&
    /(^|\n)\s*5[\)\.]\s+/.test(s)
  );
}

async function callOpenAI(userPrompt, attempt) {
  // Direct OpenAI call (Chat Completions). Retries on transient errors/timeouts.
  const maxAttempts = 3;
  const baseTimeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 35000);

  const isRetryableStatus = (status) =>
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      status: 500,
      error: "Missing OpenAI API key",
      raw: "OPENAI_API_KEY is not set",
    };
  }
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  for (let i = attempt; i <= maxAttempts; i++) {
    const controller = new AbortController();
    const timeoutMs = baseTimeoutMs + (i - 1) * 4000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
          temperature: Number(
            process.env.OPENAI_TEMPERATURE || (i === 1 ? 0.25 : 0.15)
          ),
          max_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 1600),
        }),
        signal: controller.signal,
      });

      const contentType = r.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      if (!isJson) {
        const text = await r.text();
        clearTimeout(timeoutId);

        const status = r.status || 502;
        const errObj = {
          ok: false,
          status: isRetryableStatus(status) ? status : 502,
          error: "Non-JSON response from OpenAI",
          raw: text?.slice?.(0, 8000) || text,
        };

        if (i < maxAttempts && isRetryableStatus(status)) {
          await new Promise((res) => setTimeout(res, 300 * i));
          continue;
        }

        return errObj;
      }

      const data = await r.json();
      clearTimeout(timeoutId);

      if (!r.ok) {
        const status = r.status || 502;
        const errObj = {
          ok: false,
          status,
          error: data?.error?.message || "OpenAI request failed",
          raw: { model, attempt: i, data },
        };

        if (i < maxAttempts && isRetryableStatus(status)) {
          await new Promise((res) => setTimeout(res, 350 * i));
          continue;
        }

        return errObj;
      }

      const rawText = data?.choices?.[0]?.message?.content || "";
      return { ok: true, status: 200, rawText };
    } catch (err) {
      clearTimeout(timeoutId);

      const msg = String(err?.message || err);
      const aborted =
        msg.toLowerCase().includes("aborted") ||
        msg.toLowerCase().includes("abort");

      const errObj = {
        ok: false,
        status: aborted ? 504 : 502,
        error: aborted ? "OpenAI timeout" : "OpenAI fetch failed",
        raw: msg,
      };

      if (i < maxAttempts) {
        await new Promise((res) => setTimeout(res, 400 * i));
        continue;
      }

      return errObj;
    }
  }

  return {
    ok: false,
    status: 502,
    error: "OpenAI request failed",
    raw: "unknown",
  };
}

export async function POST(req) {
  if (INTERNAL_KEY) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${INTERNAL_KEY}`) {
      return okJson({ error: "Unauthorized", reason: "unauthorized" });
    }
  }
  if (!process.env.OPENAI_API_KEY) {
    return okJson({
      error: "Missing OpenAI API key",
      reason: "missing_api_key",
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return okJson({ error: "Invalid JSON body", reason: "invalid_json" });
  }

  const { echipe, liga, status, mode } = body;

  if (!echipe || !liga) {
    return okJson({ error: "Date incomplete", reason: "missing_fields" });
  }

  // Best-effort cache to avoid repeated calls (improves speed + reduces 502s)
  const cacheKey = `${INSIGHTS_SCHEMA_VERSION}|${String(
    mode || "analysis"
  ).trim()}|${String(echipe).trim()}|${String(liga).trim()}|${String(
    status || ""
  ).trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    const res = NextResponse.json(
      mode && String(mode).toLowerCase() === "insights"
        ? { ok: true, insights: cached }
        : { ok: true, analysis: cached },
      { status: 200 }
    );
    res.headers.set("Cache-Control", "public, max-age=60");
    return withCors(res);
  }

  const promptInsights = `
You are a Senior Football Analyst. Return ONLY a single valid JSON object (no extra text, no explanations, no Markdown).

INPUT:
Match: ${echipe}
Competition: ${liga}
Current status: ${status}

GOAL:
Provide DATA ONLY for a frontend that renders:
1) a CSS pie chart (1X2 probabilities)
2) a CSS "stock-style" form line for each team (using the series)
3) a short English summary under the charts (2–3 concise sentences with key insights only, neutral tone, no betting advice).

CRITICAL RULES:
- Output MUST be ONLY valid JSON.
- Probabilities MUST be INTEGERS and MUST sum to exactly 100.
- Form series values MUST be INTEGERS in range 0..100, minimum 5 points.
- quickSummary MUST be English, 2–3 short sentences, no emojis, no marketing language, no betting tips.
- Do NOT invent sources, quotes, or claims of having access to live databases.

REQUIRED JSON SCHEMA:
{
  "probabilities": { "homeWin": number, "draw": number, "awayWin": number },
  "teamForm": {
    "home": { "label": string, "series": number[] },
    "away": { "label": string, "series": number[] }
  },
  "illustrations": {
    "home": {
      "trend": "up"|"down"|"flat",
      "volatility": "low"|"medium"|"high",
      "mood": "confident"|"balanced"|"unstable",
      "summary": string,
      "highlights": [{ "label": string, "value": number, "index": number }]
    } | null,
    "away": {
      "trend": "up"|"down"|"flat",
      "volatility": "low"|"medium"|"high",
      "mood": "confident"|"balanced"|"unstable",
      "summary": string,
      "highlights": [{ "label": string, "value": number, "index": number }]
    } | null
  },
  "quickSummary": string,
  "confidence": number,
  "notes": string
}

NOTES:
- highlights.index is the position in the series (0-based). Keep highlights to max 4 per team.
- illustrations.summary can be short (1 sentence) and must be neutral.
`;

  // MODE: insights (JSON for charts/illustrations)
  if (String(mode || "analysis").toLowerCase() === "insights") {
    // ---- Optional: enrich prompt with CURRENT squads from football-data.org ----

    let resp = await callOpenAI(promptInsights, 1);

    if (!resp.ok) {
      console.error("❌ OpenAI error (insights):", resp);
      return errorJson(
        {
          error: "AI indisponibil momentan. Încearcă din nou.",
          reason: "openai_error_insights",
          upstream_status: resp.status || 502,
          upstream_error: resp.error,
        },
        resp.status || 502
      );
    }

    const raw = String(resp.rawText || "").trim();
    const jsonText = extractFirstJsonObject(raw) || raw;

    let insights;
    try {
      insights = JSON.parse(jsonText);
    } catch (e) {
      // Retry once with stricter instruction
      const strict =
        promptInsights +
        "\n\nIMPORTANT: Răspunde acum cu DOAR JSON valid. Fără niciun caracter înainte sau după JSON.";
      const resp2 = await callOpenAI(strict, 2);
      if (!resp2.ok) {
        console.error("❌ OpenAI error (insights retry):", resp2);
        return errorJson(
          {
            error: "AI indisponibil momentan. Încearcă din nou.",
            reason: "openai_error_insights_retry",
            upstream_status: resp2.status || 502,
            upstream_error: resp2.error,
          },
          resp2.status || 502
        );
      }
      const raw2 = String(resp2.rawText || "").trim();
      const jsonText2 = extractFirstJsonObject(raw2) || raw2;
      try {
        insights = JSON.parse(jsonText2);
      } catch {
        return okJson({
          error: "Nu am putut genera un payload valid pentru grafice.",
          reason: "invalid_insights_json",
          ...(process.env.BETLOGIC_DEBUG === "1"
            ? { debug: { raw: raw2?.slice?.(0, 2000) || raw2 } }
            : {}),
        });
      }
    }

    if (!isValidInsightsPayload(insights)) {
      return okJson({
        error: "Payload-ul pentru grafice nu a trecut validarea.",
        reason: "invalid_insights_shape",
        ...(process.env.BETLOGIC_DEBUG === "1" ? { debug: { insights } } : {}),
      });
    }

    // Normalize naming to be frontend-friendly (aliases + legacy keys used by older UI)
    try {
      // ---- probabilities aliases ----
      if (insights && insights.probabilities) {
        const p = insights.probabilities;
        const homeWin = Number(p.homeWin ?? p.home ?? p.h);
        const draw = Number(p.draw ?? p.d);
        const awayWin = Number(p.awayWin ?? p.away ?? p.a);

        insights.probabilities = {
          homeWin,
          draw,
          awayWin,
          // aliases for different frontends
          home: homeWin,
          away: awayWin,
          h: homeWin,
          d: draw,
          a: awayWin,
          homeWinPct: homeWin,
          drawPct: draw,
          awayWinPct: awayWin,
        };
      }

      // ---- quick summary aliases (so UI can show it under charts) ----
      if (typeof insights?.quickSummary === "string") {
        // common aliases the UI might look for
        insights.summary = insights.quickSummary;
        insights.text = insights.quickSummary;
      }
    } catch (e) {}

    cacheSet(cacheKey, insights);
    const res = NextResponse.json({ ok: true, insights }, { status: 200 });
    res.headers.set("Cache-Control", "public, max-age=60");
    return withCors(res);
  }

  const promptBase = `
Acționează ca un Analist Sportiv Senior și Specialist în Evaluarea Riscului Competitiv. 
Generează o analiză tehnică, concisă și informativă pentru meciul specificat, bazată pe date, context sportiv și scenarii posibile.

INSTRUCȚIUNI DE LIMBĂ ȘI STATUS (OBLIGATORIU):
- LIMBĂ: Scrie în limba română perfectă, naturală și cursivă.
- FĂRĂ CODURI: Tradu orice status tehnic în română clară (ex: "NS" -> "Meciul nu a început"; "1H" -> "Prima Repriză"; "HT" -> "Pauză"; "FT" -> "Final de meci").

INSTRUCȚIUNI DE FORMAT (CRITIC):
- Output: DOAR text simplu (plain text).
- STRICT INTERZIS: Markdown, bold, italic, simboluri (#, *, _, \`), liste cu bullet-uri.
- STRUCTURĂ: Folosește exact numerotarea 1), 2), 3) etc.
- STIL: Analitic, neutru, precis, fără limbaj promoțional sau promisiuni.

DATE DE INTRARE:
Meci: ${echipe}
Liga: ${liga}
Status curent: ${status}

OBIECTIVUL ANALIZEI:
Oferă o evaluare obiectivă a contextului sportiv și a dinamicii meciului, evidențiind factori relevanți și riscuri competitive.
Analiza are scop STRICT INFORMATIV și nu reprezintă o recomandare de pariere.

STRUCTURA ANALIZEI:

1) CONTEXT ȘI MIZE:
Maxim 2 fraze. Menționează clar stadiul meciului (tradus în română) și contextul competițional al echipelor (obiective, presiune, importanța meciului).

2) DINAMICA TACTICĂ:
Maxim 3-4 fraze. Descrie interacțiunea stilurilor de joc și zonele-cheie unde se poate decide meciul.

3) FACTORI CRITICI DE ANALIZĂ:
Include exact 3 puncte numerotate distinct:
1) Situația lotului și impactul sportiv: explică influența absențelor sau revenirilor asupra jocului.
2) Tendințe statistice relevante: evidențiază pattern-uri observabile (ritm, eficiență, momente-cheie).
3) Factori externi sau contextuali: elemente care pot influența desfășurarea meciului.

4) SCENARII POSIBILE:
A) Scenariu principal: evoluția logică a meciului pe baza datelor disponibile.
B) Scenariu alternativ: condiții sau evenimente care pot modifica cursul estimat.

5) INTERPRETARE ȘI NIVEL DE INCERTITUDINE:
Evaluează nivelul general de incertitudine al meciului (Scăzut / Mediu / Ridicat) și explică într-o singură propoziție de ce rezultatul poate fi previzibil sau volatil.

NOTĂ FINALĂ (OBLIGATORIU):
Analiza este generată automat pe baza datelor disponibile și are scop exclusiv informativ. 

`;

  try {
    // Attempt 1: normal prompt
    let prompt = promptBase;
    let resp1 = await callOpenAI(prompt, 1);

    if (!resp1.ok) {
      console.error("❌ OpenAI error:", resp1);
      return errorJson(
        {
          error: "AI indisponibil momentan. Încearcă din nou.",
          reason: "openai_error",
          upstream_status: resp1.status || 502,
          upstream_error: resp1.error,
        },
        resp1.status || 502
      );
    }

    let analysis = cleanPlainText(resp1.rawText);

    // Safety net: if the model returned code/markup/garbage, retry once with stricter instructions
    if (!isValidAnalysisText(analysis)) {
      const strictAddon = `\n\nIMPORTANT: Ai returnat un output invalid anterior. Acum respectă STRICT:\n- DOAR text simplu cu secțiuni 1) ... 5)\n- Fără cod/JSON/HTML/Markdown\n- Fără caractere { } < > sau backticks\n- Dacă nu poți respecta, răspunde exact: ANALIZA_INDISPONIBILA`;

      const resp2 = await callOpenAI(promptBase + strictAddon, 2);

      if (!resp2.ok) {
        console.error("❌ OpenAI error (retry):", resp2);
        return errorJson(
          {
            error: "AI indisponibil momentan. Încearcă din nou.",
            reason: "openai_error_retry",
            upstream_status: resp2.status || 502,
            upstream_error: resp2.error,
          },
          resp2.status || 502
        );
      }

      analysis = cleanPlainText(resp2.rawText);

      if (
        !isValidAnalysisText(analysis) ||
        /^ANALIZA_INDISPONIBILA\s*$/i.test(analysis)
      ) {
        return okJson({
          error: "Nu am putut genera o analiză validă. Încearcă din nou.",
          reason: "invalid_output",
          ...(process.env.BETLOGIC_DEBUG === "1"
            ? {
                debug: {
                  tip: "Model output failed validation",
                  echipe,
                  liga,
                  status,
                },
              }
            : {}),
        });
      }
    }

    // If the output looks cut off (common with some models / low token limits), try one continuation.
    if (
      !endsWithSentencePunctuation(analysis) ||
      !hasAllMainSections(analysis)
    ) {
      const continuePrompt = `${promptBase}\n\nIMPORTANT: Textul de mai jos pare întrerupt sau incomplet. Continuă EXACT de unde ai rămas și finalizează analiza completă, respectând aceeași structură 1) ... 5) și nota finală.\n\nTEXT EXISTENT:\n${analysis}`;

      const resp3 = await callOpenAI(continuePrompt, 2);
      if (resp3.ok) {
        const cont = cleanPlainText(resp3.rawText);
        // Append only if it looks valid and adds value
        if (isValidAnalysisText(cont)) {
          // Avoid duplicating sections by trimming possible repeated prefix
          const contTrimmed = cont.replace(
            /^\s*1\)\s+[\s\S]*?(?=(\n\s*4\)|\n\s*5\)|$))/m,
            (m) => m
          );
          const merged = `${analysis}\n\n${contTrimmed}`.trim();
          // Keep the merged output only if it now looks complete
          if (
            hasAllMainSections(merged) &&
            endsWithSentencePunctuation(merged)
          ) {
            analysis = merged;
          } else if (
            hasAllMainSections(cont) &&
            endsWithSentencePunctuation(cont)
          ) {
            // If the continuation alone is better/complete, prefer it
            analysis = cont;
          }
        }
      }
    }

    if (
      !hasAllMainSections(analysis) ||
      !endsWithSentencePunctuation(analysis)
    ) {
      return okJson({
        error: "Analiza a fost întreruptă înainte de final. Încearcă din nou.",
        reason: "truncated_output",
        ...(process.env.BETLOGIC_DEBUG === "1"
          ? {
              debug: {
                tip: "Model output looked truncated",
                echipe,
                liga,
                status,
              },
            }
          : {}),
      });
    }

    cacheSet(cacheKey, analysis);
    const res = NextResponse.json({ ok: true, analysis }, { status: 200 });
    res.headers.set("Cache-Control", "public, max-age=60");
    return withCors(res);
  } catch (err) {
    console.error("🔥 Server error:", err);
    return errorJson({ error: "Server error", reason: "server_error" }, 500);
  }
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("Access-Control-Max-Age", "86400");
  return withCors(res);
}
