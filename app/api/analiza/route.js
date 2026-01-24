import { NextResponse } from "next/server";

const INTERNAL_KEY = process.env.BETLOGIC_INTERNAL_KEY;

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

function isValidInsightsPayload(obj) {
  if (!obj || typeof obj !== "object") return false;

  const p = obj?.probabilities;
  if (!p || typeof p !== "object") return false;
  const hw = Number(p.homeWin);
  const dr = Number(p.draw);
  const aw = Number(p.awayWin);
  if (![hw, dr, aw].every((n) => Number.isFinite(n))) return false;
  // Allow small rounding error
  const sum = hw + dr + aw;
  if (sum < 99.5 || sum > 100.5) return false;
  if ([hw, dr, aw].some((n) => n < 0 || n > 100)) return false;

  const tf = obj?.teamForm;
  if (!tf || typeof tf !== "object") return false;
  const homeSeries = tf?.home?.series;
  const awaySeries = tf?.away?.series;
  if (!Array.isArray(homeSeries) || !Array.isArray(awaySeries)) return false;
  if (homeSeries.length < 5 || awaySeries.length < 5) return false;
  const okSeries = (arr) =>
    arr.every(
      (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100
    );
  if (!okSeries(homeSeries) || !okSeries(awaySeries)) return false;

  // Players are optional, but if present must be shaped correctly
  const checkPlayer = (pl) => {
    if (pl == null) return true;
    if (typeof pl !== "object") return false;
    if (typeof pl.name !== "string" || !pl.name.trim()) return false;
    if (typeof pl.role !== "string" || !pl.role.trim()) return false;
    const fi = Number(pl.formIndex);
    if (!Number.isFinite(fi) || fi < 0 || fi > 100) return false;
    return true;
  };

  if (!checkPlayer(obj?.players?.home?.bestInForm)) return false;
  if (!checkPlayer(obj?.players?.away?.bestInForm)) return false;

  const checkScorer = (pl) => {
    if (pl == null) return true;
    if (typeof pl !== "object") return false;
    if (typeof pl.name !== "string" || !pl.name.trim()) return false;
    const goals = Number(pl.goals);
    if (!Number.isFinite(goals) || goals < 0 || goals > 200) return false;
    const fi = Number(pl.formIndex);
    if (!Number.isFinite(fi) || fi < 0 || fi > 100) return false;
    return true;
  };

  if (!checkScorer(obj?.players?.home?.topScorer)) return false;
  if (!checkScorer(obj?.players?.away?.topScorer)) return false;

  // Optional: stock illustration descriptors for each team (used by UI / image generators)
  const ill = obj?.illustrations;
  const checkIll = (x) => {
    if (x == null) return true;
    if (typeof x !== "object") return false;
    if (typeof x.prompt !== "string" || x.prompt.trim().length < 20)
      return false;
    if (typeof x.trend !== "string" || !x.trend.trim()) return false;
    if (typeof x.summary !== "string" || x.summary.trim().length < 10)
      return false;
    return true;
  };
  if (ill != null) {
    if (typeof ill !== "object") return false;
    if (!checkIll(ill?.home)) return false;
    if (!checkIll(ill?.away)) return false;
  }

  const ci = Number(obj?.confidence);
  if (!Number.isFinite(ci) || ci < 0 || ci > 100) return false;

  return true;
}

function looksLikeCodeOrMarkup(raw) {
  const s = String(raw || "");
  const lower = s.toLowerCase();

  // Strong signals for code/markup/data dumps
  const patterns = [
    /```[\s\S]*?```/m,
    /<\/?(html|head|body|script|style|div|span|pre|code)[\s>]/i,
    /<\?php/i,
    /\b(import|export)\b\s+/i,
    /\b(function|class)\b\s+[a-z0-9_]+\s*\(/i,
    /\bconst\b\s+[a-z0-9_]+\s*=/i,
    /\blet\b\s+[a-z0-9_]+\s*=/i,
    /\bvar\b\s+[a-z0-9_]+\s*=/i,
    /\breturn\b\s+/i,
    /\bconsole\.log\b/i,
    /\bSELECT\b\s+.*\bFROM\b/i,
    /^\s*\{\s*"[^"]+"\s*:/m, // JSON object
    /^\s*\[\s*\{\s*"[^"]+"\s*:/m, // JSON array of objects
    /^\s*<\?xml\b/i,
  ];

  if (patterns.some((re) => re.test(s))) return true;

  // If it still contains lots of typical markdown/formatting artifacts
  if (/(^|\n)\s*#{1,6}\s+/.test(s)) return true;
  if (/(^|\n)\s*[-•]\s+/.test(s)) return true;

  // If it's extremely short, it's usually not a real analysis
  const stripped = s.replace(/\s+/g, " ").trim();
  if (stripped.length < 120) return true;

  // If it contains too many braces/semicolons relative to length
  const braceCount = (s.match(/[{}]/g) || []).length;
  const semiCount = (s.match(/;/g) || []).length;
  if (braceCount + semiCount >= 14) return true;

  // If it looks like an error message or system-like output
  if (lower.includes("openrouter") && lower.includes("error")) return true;
  if (lower.includes("missing") && lower.includes("key")) return true;

  return false;
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
  const cacheKey = `${String(mode || "analysis").trim()}|${String(
    echipe
  ).trim()}|${String(liga).trim()}|${String(status || "").trim()}`;
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
3) two player highlight cards per team (best in-form + top scorer) when you are confident. If unsure, return null.

CRITICAL RULES:
- Output MUST be ONLY valid JSON.
- Probabilities MUST be INTEGERS and MUST sum to exactly 100.
- Form series values MUST be INTEGERS in range 0..100, minimum 5 points.
- Do NOT invent sources, quotes, or claims of having access to live databases.
- If you are unsure about player names, set the player object to null and lower confidence.

REQUIRED JSON SCHEMA:
{
  "probabilities": { "homeWin": number, "draw": number, "awayWin": number },
  "teamForm": {
    "home": { "label": string, "series": number[] },
    "away": { "label": string, "series": number[] }
  },
  "players": {
    "home": {
      "bestInForm": { "name": string, "role": string, "formIndex": number } | null,
      "topScorer": { "name": string, "goals": number, "formIndex": number } | null
    },
    "away": {
      "bestInForm": { "name": string, "role": string, "formIndex": number } | null,
      "topScorer": { "name": string, "goals": number, "formIndex": number } | null
    }
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
  "confidence": number,
  "notes": string
}

NOTES:
- formIndex is an integer 0..100.
- goals is an integer.
- highlights.index is the position in the series (0-based). Keep highlights to max 4 per team.
`;

  // MODE: insights (JSON for charts/illustrations)
  if (String(mode || "analysis").toLowerCase() === "insights") {
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
