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

  // Must contain at least a couple of structured sections cues
  const hasNumbered = /(^|\n)\s*\d\)\s+/.test(s);
  const hasScenarii = /scenari/i.test(s);
  const hasRecomand = /recomand/i.test(s) || /selec/i.test(s);
  return hasNumbered && (hasScenarii || hasRecomand);
}

async function callOpenRouter(userPrompt, attempt) {
  // We keep this relatively short for performance. If OpenRouter is slow/unavailable,
  // we retry once (or twice) with backoff and a lower temperature.
  const maxAttempts = 3;
  const baseTimeoutMs = 22000; // avoid premature aborts (often the #1 source of 502)

  const isRetryableStatus = (status) =>
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504;

  for (let i = attempt; i <= maxAttempts; i++) {
    const controller = new AbortController();
    const timeoutMs = baseTimeoutMs + (i - 1) * 4000; // progressive timeout
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.HTTP_REFERER || "https://betlogic.ro",
          "X-Title": process.env.APP_TITLE || "BetLogic",
        },
        body: JSON.stringify({
          model:
            process.env.OPENROUTER_MODEL || "mistralai/mistral-7b-instruct",
          messages: [{ role: "user", content: userPrompt }],
          temperature: i === 1 ? 0.5 : 0.2,
          max_tokens: 650,
        }),
        signal: controller.signal,
      });

      const contentType = r.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      // If OpenRouter/CDN returns HTML (common on 502/504), treat as retryable.
      if (!isJson) {
        const text = await r.text();
        clearTimeout(timeoutId);

        const status = r.status || 502;
        const errObj = {
          ok: false,
          status: isRetryableStatus(status) ? status : 502,
          error: "Non-JSON response from OpenRouter",
          raw: text?.slice?.(0, 8000) || text,
        };

        if (i < maxAttempts) {
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
          error: data?.error?.message || "OpenRouter request failed",
          raw: data,
        };

        // Retry on transient statuses
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
        error: aborted ? "OpenRouter timeout" : "OpenRouter fetch failed",
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
    error: "OpenRouter request failed",
    raw: "unknown",
  };
}

export async function POST(req) {
  if (INTERNAL_KEY) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${INTERNAL_KEY}`) {
      return withCors(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );
    }
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return withCors(
      NextResponse.json(
        { error: "Missing OpenRouter API key" },
        { status: 500 }
      )
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return withCors(
      NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    );
  }

  const { echipe, liga, status } = body;

  if (!echipe || !liga) {
    return withCors(
      NextResponse.json({ error: "Date incomplete" }, { status: 400 })
    );
  }

  // Best-effort cache to avoid repeated calls (improves speed + reduces 502s)
  const cacheKey = `${String(echipe).trim()}|${String(liga).trim()}|${String(
    status || ""
  ).trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    const res = NextResponse.json({ analysis: cached });
    res.headers.set("Cache-Control", "public, max-age=60");
    return withCors(res);
  }

  const promptBase = `Acționează ca un Senior Risk Manager și Analist Sportiv de elită. Generează o analiză tehnică, ultra-concisă și orientată strict pe profitabilitate și risc pentru meciul specificat.

INSTRUCȚIUNI DE LIMBĂ ȘI STATUS (OBLIGATORIU):
- LIMBĂ: Scrie în limba română perfectă, naturală și cursivă.
- FĂRĂ CODURI: Tradu orice status tehnic în română clară (ex: "NS" -> "Meciul nu a început"; "1H" -> "Prima Repriză"; "HT" -> "Pauză"; "FT" -> "Final de meci").

INSTRUCȚIUNI DE FORMAT (CRITIC):
- Output: DOAR text simplu (plain text).
- STRICT INTERZIS: Markdown, bold, italic, simboluri (#, *, _, \`), liste cu bullet-uri.
- STRUCTURĂ: Folosește exact numerotarea 1), 2), 3) etc.
- STIL: Chirurgical, dens, fără umplutură.

DATE INTRARE:
Meci: ${echipe}
Liga: ${liga}
Status curent: ${status}

OBIECTIVUL ANALIZEI:
Oferă informația pe care casele de pariuri ar prefera să o ignore jucătorii. Concentrează-te pe valoare (value betting) și riscuri ascunse.

STRUCTURA ANALIZEI:

1) CONTEXT ȘI MIZE:
Maxim 2 fraze. Menționează clar stadiul meciului (tradus în română) și motivația reală a echipelor (luptă la titlu, evitare retrogradare, meci amical deghizat etc.).

2) DINAMICA TACTICĂ:
Maxim 3-4 fraze. Descrie "match-up-ul": cum se lovește atacul unei echipe de apărarea celeilalte? (Ex: "Echipa gazdă domină posesia steril, oaspeții sunt letali pe contraatac").

3) PUNCTE CRITICE DE INTERES (RESEARCH AVANSAT):
Aici trebuie să oferi "aurul" pentru pariori. Include 3 puncte numerotate distinct:
1) Situația lotului & Impact: Nu enumera doar accidentații, ci explică impactul (ex: "Lipsește golgheterul X, deci forța ofensivă scade cu 40%").
2) Statistici de nișă: Caută tendințe specifice (ex: cornere, cartonașe, goluri marcate târziu, eficiență acasă vs deplasare).
3) Factori X: Elemente externe care pot decide meciul (ex: arbitru care dă ușor cartonașe, starea gazonului, oboseală după cupă europeană, conflicte interne).

4) SCENARII PROBABILE:
A) Scenariu principal: Ce este logic să se întâmple (ex: victorie scurtă, meci închis).
B) Scenariu de risc: Ce poate răsturna calculul hârtiei.

5) RECOMANDĂRI (UNGHIURI DE PARIERE):
1) Selecție principală: [Tip pariu] - [Argument scurt bazat pe statistică/tactică]
2) Selecție alternativă/Live: [Tip pariu] - [Condiția necesară (ex: dacă nu se marchează în primele 20 min)]

NIVEL DE RISC: Scăzut / Mediu / Ridicat (Argumentează într-o singură propoziție).
`;

  try {
    // Attempt 1: normal prompt
    let prompt = promptBase;
    let resp1 = await callOpenRouter(prompt, 1);

    if (!resp1.ok) {
      console.error("❌ OpenRouter error:", resp1);
      return withCors(
        NextResponse.json(
          { error: resp1.error },
          { status: resp1.status || 502 }
        )
      );
    }

    let analysis = cleanPlainText(resp1.rawText);

    // Safety net: if the model returned code/markup/garbage, retry once with stricter instructions
    if (!isValidAnalysisText(analysis)) {
      const strictAddon = `\n\nIMPORTANT: Ai returnat un output invalid anterior. Acum respectă STRICT:\n- DOAR text simplu cu secțiuni 1) ... 5)\n- Fără cod/JSON/HTML/Markdown\n- Fără caractere { } < > sau backticks\n- Dacă nu poți respecta, răspunde exact: ANALIZA_INDISPONIBILA`;

      const resp2 = await callOpenRouter(promptBase + strictAddon, 2);

      if (!resp2.ok) {
        console.error("❌ OpenRouter error (retry):", resp2);
        return withCors(
          NextResponse.json(
            { error: resp2.error },
            { status: resp2.status || 502 }
          )
        );
      }

      analysis = cleanPlainText(resp2.rawText);

      if (
        !isValidAnalysisText(analysis) ||
        /^ANALIZA_INDISPONIBILA\s*$/i.test(analysis)
      ) {
        return withCors(
          NextResponse.json(
            {
              error: "Nu am putut genera o analiză validă. Încearcă din nou.",
              reason: "invalid_output",
            },
            { status: 502 }
          )
        );
      }
    }

    cacheSet(cacheKey, analysis);
    const res = NextResponse.json({ analysis });
    res.headers.set("Cache-Control", "public, max-age=60");
    return withCors(res);
  } catch (err) {
    console.error("🔥 Server error:", err);
    return withCors(
      NextResponse.json({ error: "Server error" }, { status: 500 })
    );
  }
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("Access-Control-Max-Age", "86400");
  return withCors(res);
}
