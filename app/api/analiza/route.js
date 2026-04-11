import { NextResponse } from "next/server";

// ── Env validation (fail-fast at cold start, not at first request) ──
const REQUIRED_ENV = ["OPENAI_API_KEY"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[BetLogic] FATAL: Missing required env var ${key}`);
  }
}

const INTERNAL_KEY = process.env.BETLOGIC_INTERNAL_KEY;
// Bump this when you change the insights schema/prompt so cached payloads don't keep old shapes.
const INSIGHTS_SCHEMA_VERSION = "2026-03-10-v5";

// Max request body size (bytes) to prevent abuse
const MAX_BODY_SIZE = 64 * 1024; // 64 KB

// Simple in-memory cache (best-effort). Helps performance and reduces 502s from upstream.
// Note: Vercel/serverless may evict between invocations; still useful under load.
const ANALYSIS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 200; // LRU eviction cap to prevent memory leaks
const __cache =
  globalThis.__betlogicAnalysisCache ||
  (globalThis.__betlogicAnalysisCache = new Map());

// Best-effort per-IP rate limiter (globalThis persists across warm invocations)
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX_HITS = 30;
const __rateLimiter =
  globalThis.__betlogicRateLimiter ||
  (globalThis.__betlogicRateLimiter = new Map());

function rateLimitOk(ip) {
  if (!ip) return true; // fail-open if no IP
  const now = Date.now();
  const entry = __rateLimiter.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    __rateLimiter.set(ip, { count: 1, start: now });
    // Evict old entries periodically
    if (__rateLimiter.size > 500) {
      for (const [k, v] of __rateLimiter) {
        if (now - v.start > RATE_LIMIT_WINDOW_MS) __rateLimiter.delete(k);
      }
    }
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_HITS) return false;
  entry.count++;
  return true;
}

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
  // LRU eviction: if cache is full, delete the oldest entry
  if (__cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = __cache.keys().next().value;
    if (oldest !== undefined) __cache.delete(oldest);
  }
  __cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function withCors(res) {
  const origin = process.env.WP_ORIGIN || "https://betlogic.ro";
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-BetLogic-Internal",
  );
  res.headers.set("Access-Control-Allow-Credentials", "true");
  return res;
}

function hasValidInternalAuth(req) {
  if (!INTERNAL_KEY) return false;

  const candidates = [
    req.headers.get("authorization") || "",
    req.headers.get("x-betlogic-internal") || "",
  ];

  return candidates.some((candidate) => {
    let value = String(candidate || "").trim();
    if (!value) return false;
    if (value.toLowerCase().startsWith("bearer ")) {
      value = value.slice(7).trim();
    }
    return value === INTERNAL_KEY;
  });
}

function isSameOriginBrowserRequest(req) {
  const origin = (req.headers.get("origin") || "").trim();
  const referer = (req.headers.get("referer") || "").trim();
  const secFetchSite = (req.headers.get("sec-fetch-site") || "").toLowerCase();
  const secFetchMode = (req.headers.get("sec-fetch-mode") || "").toLowerCase();

  let requestOrigin = "";
  try {
    requestOrigin = new URL(req.url).origin;
  } catch {
    requestOrigin = "";
  }

  if (!requestOrigin) return false;

  const originMatches =
    origin === requestOrigin ||
    (referer !== "" && referer.startsWith(`${requestOrigin}/`));

  if (!originMatches) return false;

  if (
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "same-site"
  ) {
    return false;
  }

  if (
    secFetchMode &&
    secFetchMode !== "cors" &&
    secFetchMode !== "same-origin"
  ) {
    return false;
  }

  return true;
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

function extractSummaryLines(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\s*[-•*–]\s*/, "").trim())
      .filter(Boolean);
  }

  let s = String(raw || "");
  if (!s.trim()) return [];

  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`+/g, "");
  s = s.replace(/\[(.*?)\]\((.*?)\)/g, "$1");
  s = s.replace(/\r\n/g, "\n").trim();

  let lines = s
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  // Some models collapse bullet lines into a single paragraph separated by bullets.
  if (lines.length <= 1 && /[•\u2022]/.test(s)) {
    lines = s
      .split(/[•\u2022]/)
      .map((line) => String(line || "").trim())
      .filter(Boolean);
  }

  return lines
    .map((line) => line.replace(/^\s*[-•*–]\s*/, "").trim())
    .filter(Boolean);
}

function normalizeQuickSummary(raw) {
  const lines = extractSummaryLines(raw);
  return {
    lines,
    text: lines.join("\n").trim(),
  };
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
  // Find a matching closing brace, tracking string literals to avoid false matches
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
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
      (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100,
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
  const normalizedSummary = normalizeQuickSummary(obj.quickSummary);
  const qs = normalizedSummary.text;
  if (qs.length < 20 || qs.length > 2000) return false;
  if (normalizedSummary.lines.length < 5 || normalizedSummary.lines.length > 6)
    return false;
  if (
    normalizedSummary.lines.some(
      (line) =>
        line.length < 8 || line.length > 160 || looksLikeCodeOrMarkup(line),
    )
  ) {
    return false;
  }

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

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeProbabilityTriple(home, draw, away) {
  const raw = [
    clampNumber(toFiniteNumber(home, 0), 0, 100),
    clampNumber(toFiniteNumber(draw, 0), 0, 100),
    clampNumber(toFiniteNumber(away, 0), 0, 100),
  ];
  const sum = raw[0] + raw[1] + raw[2];
  if (sum <= 0) {
    return { homeWin: 34, draw: 28, awayWin: 38 };
  }

  const scaled = raw.map((v) => (v / sum) * 100);
  const floored = scaled.map((v) => Math.floor(v));
  let remainder = 100 - floored.reduce((acc, v) => acc + v, 0);

  const order = scaled
    .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  for (let i = 0; i < order.length && remainder > 0; i += 1) {
    floored[order[i].idx] += 1;
    remainder -= 1;
  }

  return {
    homeWin: floored[0],
    draw: floored[1],
    awayWin: floored[2],
  };
}

function oddsToImpliedProbabilities(odds) {
  const home = toFiniteNumber(odds?.home, 0);
  const draw = toFiniteNumber(odds?.draw, 0);
  const away = toFiniteNumber(odds?.away, 0);
  if (!(home > 1.01) || !(away > 1.01)) return null;

  const invHome = 1 / home;
  const invDraw = draw > 1.01 ? 1 / draw : 0;
  const invAway = 1 / away;
  return normalizeProbabilityTriple(
    invHome * 100,
    invDraw * 100,
    invAway * 100,
  );
}

function inferTipLean(market, teams) {
  const m = String(market || "")
    .trim()
    .toLowerCase();
  if (!m) return "";

  const home = String(teams?.home || "")
    .trim()
    .toLowerCase();
  const away = String(teams?.away || "")
    .trim()
    .toLowerCase();

  if (/^1x\b/.test(m) || m.includes("home or draw")) return "home";
  if (/^x2\b/.test(m) || m.includes("away or draw")) return "away";
  if (m === "draw") return "draw";
  if (m.includes(" no draw")) return "";
  if (m.includes("btts") || m.includes("over ") || m.includes("under "))
    return "";
  if (home && m.includes(home) && m.includes("win")) return "home";
  if (away && m.includes(away) && m.includes("win")) return "away";
  return "";
}

function buildAnchorFromTipsContext(ctx) {
  if (!ctx || typeof ctx !== "object") return null;

  const teams = {
    home: String(ctx?.teams?.home || "Home").trim() || "Home",
    away: String(ctx?.teams?.away || "Away").trim() || "Away",
  };

  const prior = normalizeProbabilityTriple(
    ctx?.probabilities?.home_win,
    ctx?.probabilities?.draw,
    ctx?.probabilities?.away_win,
  );

  const xg = {
    home: clampNumber(toFiniteNumber(ctx?.xg?.home, 0), 0, 6),
    away: clampNumber(toFiniteNumber(ctx?.xg?.away, 0), 0, 6),
    total: clampNumber(toFiniteNumber(ctx?.xg?.total, 0), 0, 10),
  };
  if (xg.total <= 0 && (xg.home > 0 || xg.away > 0)) {
    xg.total = xg.home + xg.away;
  }

  const form = {
    home_ppg: clampNumber(toFiniteNumber(ctx?.form?.home_ppg, 0), 0, 3.5),
    away_ppg: clampNumber(toFiniteNumber(ctx?.form?.away_ppg, 0), 0, 3.5),
    home_last5_points: clampNumber(
      toFiniteNumber(ctx?.form?.home_last5_points, 0),
      0,
      15,
    ),
    away_last5_points: clampNumber(
      toFiniteNumber(ctx?.form?.away_last5_points, 0),
      0,
      15,
    ),
    home_form: String(ctx?.form?.home_form || "").trim(),
    away_form: String(ctx?.form?.away_form || "").trim(),
  };

  const h2h = {
    sample: clampNumber(toFiniteNumber(ctx?.h2h?.sample, 0), 0, 10),
    home_wins: clampNumber(toFiniteNumber(ctx?.h2h?.home_wins, 0), 0, 10),
    away_wins: clampNumber(toFiniteNumber(ctx?.h2h?.away_wins, 0), 0, 10),
    draws: clampNumber(toFiniteNumber(ctx?.h2h?.draws, 0), 0, 10),
    last_winner: String(ctx?.h2h?.last_winner || "")
      .trim()
      .toLowerCase(),
    last_score: String(ctx?.h2h?.last_score || "").trim(),
  };

  const sampleGames = clampNumber(
    toFiniteNumber(ctx?.sample_games_per_team, 0),
    0,
    20,
  );
  const topTips = Array.isArray(ctx?.top_tips) ? ctx.top_tips : [];
  const marketOdds = oddsToImpliedProbabilities(ctx?.market_odds || null);

  let home = prior.homeWin;
  let draw = prior.draw;
  let away = prior.awayWin;

  const xgDiff = xg.home - xg.away;
  const ppgDiff = form.home_ppg - form.away_ppg;
  const last5Diff = (form.home_last5_points - form.away_last5_points) / 3;

  home += clampNumber(xgDiff * 6.5, -6, 6);
  away -= clampNumber(xgDiff * 6.5, -6, 6);

  home += clampNumber(ppgDiff * 4.5, -5, 5);
  away -= clampNumber(ppgDiff * 4.5, -5, 5);

  home += clampNumber(last5Diff * 2.2, -3.5, 3.5);
  away -= clampNumber(last5Diff * 2.2, -3.5, 3.5);

  if (xg.total <= 2.15) draw += 3.5;
  else if (xg.total >= 3.15) draw -= 3;

  if (h2h.sample > 0) {
    const h2hDiff = (h2h.home_wins - h2h.away_wins) / h2h.sample;
    home += clampNumber(h2hDiff * 4.2, -3.5, 3.5);
    away -= clampNumber(h2hDiff * 4.2, -3.5, 3.5);
    if (h2h.last_winner === "home") home += 1.2;
    if (h2h.last_winner === "away") away += 1.2;
  }

  const consensus = { home: 0, away: 0, draw: 0 };
  for (const tip of topTips.slice(0, 3)) {
    const lean = inferTipLean(tip?.market, teams);
    const tipProb = clampNumber(toFiniteNumber(tip?.probability, 0), 0, 100);
    const edge = clampNumber(toFiniteNumber(tip?.edge_pp, 0), -30, 30);
    const strength =
      clampNumber((tipProb - 50) * 0.05, 0, 2.8) +
      clampNumber(Math.abs(edge) * 0.06, 0, 2.2);

    if (lean === "home") {
      home += strength;
      consensus.home += 1;
    } else if (lean === "away") {
      away += strength;
      consensus.away += 1;
    } else if (lean === "draw") {
      draw += Math.min(2.6, strength || 1.2);
      consensus.draw += 1;
    }
  }

  let probabilities = normalizeProbabilityTriple(home, draw, away);

  if (marketOdds) {
    probabilities = normalizeProbabilityTriple(
      probabilities.homeWin * 0.84 + marketOdds.homeWin * 0.16,
      probabilities.draw * 0.84 + marketOdds.draw * 0.16,
      probabilities.awayWin * 0.84 + marketOdds.awayWin * 0.16,
    );
  }

  const awayStructuralEdge =
    xgDiff <= -0.25 ||
    ppgDiff <= -0.32 ||
    form.away_last5_points >= form.home_last5_points + 3;
  const homeStructuralEdge =
    xgDiff >= 0.25 ||
    ppgDiff >= 0.32 ||
    form.home_last5_points >= form.away_last5_points + 3;

  if (
    awayStructuralEdge &&
    prior.awayWin >= prior.homeWin &&
    probabilities.homeWin >= probabilities.awayWin
  ) {
    const shift = Math.min(
      6,
      probabilities.homeWin - probabilities.awayWin + 1,
    );
    probabilities = normalizeProbabilityTriple(
      probabilities.homeWin - shift,
      probabilities.draw,
      probabilities.awayWin + shift,
    );
  }

  if (
    homeStructuralEdge &&
    prior.homeWin >= prior.awayWin &&
    probabilities.awayWin >= probabilities.homeWin
  ) {
    const shift = Math.min(
      6,
      probabilities.awayWin - probabilities.homeWin + 1,
    );
    probabilities = normalizeProbabilityTriple(
      probabilities.homeWin + shift,
      probabilities.draw,
      probabilities.awayWin - shift,
    );
  }

  const lean =
    probabilities.homeWin >= probabilities.awayWin + 2
      ? "home"
      : probabilities.awayWin >= probabilities.homeWin + 2
        ? "away"
        : "draw";

  const tipConsensus = Math.max(consensus.home, consensus.away, consensus.draw);
  let confidence =
    46 +
    Math.abs(probabilities.homeWin - probabilities.awayWin) * 0.58 +
    Math.abs(xgDiff) * 11 +
    Math.min(sampleGames, 10) * 1.2 +
    tipConsensus * 3.2;

  if (h2h.sample > 0) confidence += Math.min(h2h.sample, 5) * 0.8;
  if (marketOdds) confidence += 3;
  confidence = Math.round(clampNumber(confidence, 48, 91));

  return {
    teams,
    probabilities,
    xg,
    form,
    h2h,
    sampleGames,
    marketOdds,
    lean,
    confidence,
  };
}

function buildPromptContextBlock(extra, anchor) {
  const lines = [];
  if (anchor) {
    lines.push("QUANT MODEL ANCHOR:");
    lines.push(
      `- Prior 1X2 probabilities: Home ${anchor.probabilities.homeWin} / Draw ${anchor.probabilities.draw} / Away ${anchor.probabilities.awayWin}.`,
    );
    lines.push(
      `- xG anchor: ${anchor.teams.home} ${anchor.xg.home.toFixed(2)} vs ${anchor.teams.away} ${anchor.xg.away.toFixed(2)} (total ${anchor.xg.total.toFixed(2)}).`,
    );
    lines.push(
      `- Form anchor: home ${anchor.form.home_ppg.toFixed(2)} PPG / ${anchor.form.home_form || "-"} vs away ${anchor.form.away_ppg.toFixed(2)} PPG / ${anchor.form.away_form || "-"}.`,
    );
    if (anchor.h2h.sample > 0) {
      lines.push(
        `- H2H anchor: home ${anchor.h2h.home_wins}, away ${anchor.h2h.away_wins}, draws ${anchor.h2h.draws} from last ${anchor.h2h.sample}.`,
      );
    }
    if (anchor.marketOdds) {
      lines.push(
        `- Market sanity check: Home ${anchor.marketOdds.homeWin} / Draw ${anchor.marketOdds.draw} / Away ${anchor.marketOdds.awayWin}.`,
      );
    }
    lines.push(
      "- Home advantage is allowed only as a SMALL nudge. Venue alone must never flip the stronger side.",
    );
    lines.push(
      "- If the away team has the better xG prior, better PPG and the prior model already leans away, keep away ahead unless hard evidence contradicts it.",
    );
    lines.push(
      "- H2H is secondary evidence. It can refine, but it must not override stronger current-form and xG signals by itself.",
    );
  }

  const extraText = String(extra || "").trim();
  if (extraText) {
    lines.push("ADDITIONAL STRUCTURED CONTEXT:");
    lines.push(extraText);
  }

  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

function blendInsightsWithAnchor(insights, anchor) {
  if (!insights || !anchor || !insights.probabilities) return insights;

  const aiProb = normalizeProbabilityTriple(
    insights.probabilities.homeWin ?? insights.probabilities.home,
    insights.probabilities.draw,
    insights.probabilities.awayWin ?? insights.probabilities.away,
  );

  const prior = anchor.probabilities;
  const aiLean =
    aiProb.homeWin >= aiProb.awayWin + 2
      ? "home"
      : aiProb.awayWin >= aiProb.homeWin + 2
        ? "away"
        : "draw";
  const priorWeight = aiLean && aiLean !== anchor.lean ? 0.8 : 0.7;

  let merged = normalizeProbabilityTriple(
    prior.homeWin * priorWeight + aiProb.homeWin * (1 - priorWeight),
    prior.draw * priorWeight + aiProb.draw * (1 - priorWeight),
    prior.awayWin * priorWeight + aiProb.awayWin * (1 - priorWeight),
  );

  if (
    anchor.lean === "away" &&
    prior.awayWin >= prior.homeWin &&
    merged.homeWin >= merged.awayWin
  ) {
    const shift = Math.min(6, merged.homeWin - merged.awayWin + 1);
    merged = normalizeProbabilityTriple(
      merged.homeWin - shift,
      merged.draw,
      merged.awayWin + shift,
    );
  }

  if (
    anchor.lean === "home" &&
    prior.homeWin >= prior.awayWin &&
    merged.awayWin >= merged.homeWin
  ) {
    const shift = Math.min(6, merged.awayWin - merged.homeWin + 1);
    merged = normalizeProbabilityTriple(
      merged.homeWin + shift,
      merged.draw,
      merged.awayWin - shift,
    );
  }

  insights.probabilities = {
    ...insights.probabilities,
    homeWin: merged.homeWin,
    draw: merged.draw,
    awayWin: merged.awayWin,
  };

  const currentConfidence = clampNumber(
    toFiniteNumber(insights.confidence, anchor.confidence),
    0,
    100,
  );
  insights.confidence = Math.round(
    clampNumber(anchor.confidence * 0.72 + currentConfidence * 0.28, 0, 100),
  );

  const anchorNote = `Model anchor kept 1X2 close to ${anchor.teams.home} ${merged.homeWin}% / Draw ${merged.draw}% / ${anchor.teams.away} ${merged.awayWin}% with capped venue bias.`;
  const existingNotes =
    typeof insights.notes === "string" ? insights.notes.trim() : "";
  insights.notes = existingNotes
    ? `${anchorNote} ${existingNotes}`.trim()
    : anchorNote;

  return insights;
}

async function callOpenAI(systemPrompt, userPrompt, attempt, reqSignal) {
  // Direct OpenAI call (Chat Completions). Retries on transient errors/timeouts.
  // systemPrompt: stable instructions (enables OpenAI prefix caching)
  // userPrompt:   per-request dynamic content
  // reqSignal:    optional AbortSignal from the incoming request
  const maxAttempts = Math.max(
    1,
    Math.min(3, Number(process.env.OPENAI_MAX_ATTEMPTS || 2) || 2),
  );
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

    // Forward client abort to cancel upstream OpenAI call
    const onClientAbort = () => controller.abort();
    if (reqSignal && !reqSignal.aborted) {
      reqSignal.addEventListener("abort", onClientAbort, { once: true });
    }

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: userPrompt });

    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: Number(
            process.env.OPENAI_TEMPERATURE || (i === 1 ? 0.25 : 0.15),
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
        if (reqSignal) reqSignal.removeEventListener("abort", onClientAbort);

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
      if (reqSignal) reqSignal.removeEventListener("abort", onClientAbort);

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
      if (reqSignal) reqSignal.removeEventListener("abort", onClientAbort);

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
  const authorizedInternal = hasValidInternalAuth(req);
  const sameOriginBrowser = isSameOriginBrowserRequest(req);

  if (!authorizedInternal && !sameOriginBrowser) {
    return errorJson({ error: "Unauthorized", reason: "unauthorized" }, 401);
  }
  if (!process.env.OPENAI_API_KEY) {
    return errorJson(
      {
        error: "Missing OpenAI API key",
        reason: "missing_api_key",
      },
      500,
    );
  }

  // Rate limiting per IP (best-effort, survives warm invocations)
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (!rateLimitOk(clientIp)) {
    const retryAfterSec = Math.ceil(
      (RATE_LIMIT_WINDOW_MS -
        (Date.now() - (__rateLimiter.get(clientIp)?.start || Date.now()))) /
        1000,
    );
    const res = errorJson(
      { error: "Too many requests. Try again later.", reason: "rate_limited" },
      429,
    );
    res.headers.set("Retry-After", String(Math.max(1, retryAfterSec)));
    return res;
  }

  const __reqStart = Date.now();
  /** Stamp a response with timing header */
  function withTiming(res) {
    res.headers.set("X-Response-Time", `${Date.now() - __reqStart}ms`);
    return res;
  }

  // Body size guard: reject oversized payloads before parsing
  const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    return errorJson(
      { error: "Request body too large", reason: "body_too_large" },
      413,
    );
  }

  let body;
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_SIZE) {
      return errorJson(
        { error: "Request body too large", reason: "body_too_large" },
        413,
      );
    }
    body = JSON.parse(rawBody);
  } catch {
    return errorJson(
      { error: "Invalid JSON body", reason: "invalid_json" },
      400,
    );
  }

  const echipe = typeof body?.echipe === "string" ? body.echipe.trim() : "";
  const liga = typeof body?.liga === "string" ? body.liga.trim() : "";
  const status = typeof body?.status === "string" ? body.status.trim() : "";
  const mode = typeof body?.mode === "string" ? body.mode.trim() : "";
  const extra = typeof body?.extra === "string" ? body.extra.trim() : "";
  const tipsContext =
    body?.tips_context && typeof body.tips_context === "object"
      ? body.tips_context
      : {};
  const postId = Math.max(0, parseInt(body?.post_id, 10) || 0);
  const matchId = Math.max(0, parseInt(body?.match_id, 10) || 0);
  const normalizedMode = String(mode || "analysis")
    .trim()
    .toLowerCase();

  if (!echipe || !liga) {
    return errorJson(
      { error: "Date incomplete", reason: "missing_fields" },
      400,
    );
  }

  let contextSignature = "";
  try {
    contextSignature = JSON.stringify({
      extra,
      tipsContext,
      postId,
      matchId,
    });
  } catch {
    contextSignature = `${extra}|${postId}|${matchId}`;
  }
  const modelAnchor = buildAnchorFromTipsContext(tipsContext);
  const promptContextBlock = buildPromptContextBlock(extra, modelAnchor);

  // Best-effort cache to avoid repeated calls (improves speed + reduces 502s)
  const cacheKey = `${INSIGHTS_SCHEMA_VERSION}|${String(
    normalizedMode || "analysis",
  ).trim()}|${String(echipe).trim()}|${String(liga).trim()}|${String(
    status || "",
  ).trim()}|${contextSignature}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    const res = NextResponse.json(
      normalizedMode === "insights"
        ? { ok: true, insights: cached }
        : { ok: true, analysis: cached },
      { status: 200 },
    );
    res.headers.set("Cache-Control", "private, no-store");
    console.log(
      `✅ [cache-hit] ${echipe} | ${normalizedMode || "analysis"} | ${Date.now() - __reqStart}ms`,
    );
    return withCors(withTiming(res));
  }

  // ─── Insights mode: system prompt (stable → OpenAI prefix caching) ───
  const insightsSystemPrompt = `You are an Elite Sharp Value Betting Analyst specialized in spotting mispriced markets through xG modeling, BTTS trends, Over/Under leans, game tempo and high-impact player props.

Return ONLY a single valid JSON object (no extra text, no explanations, no Markdown).

GOAL:
Deliver ultra-sharp DATA ONLY for a frontend that renders:
1) a CSS pie chart (1X2 probabilities)
2) a CSS "stock-style" form line for each team (using the series)
3) a SHORT, betting-focused English summary under the charts — optimized for serious value bettors.

CRITICAL RULES:
- Output MUST be ONLY valid JSON.
- Probabilities MUST be sharp, well-calibrated INTEGERS and MUST sum to exactly 100.
- Treat the QUANT MODEL ANCHOR above as the hard prior. Do not drift far from it unless the structured context clearly justifies that shift.
- Home advantage is a small adjustment only. It MUST NOT become the main reason to flip a stronger away side.
- If away xG, away form and the anchor prior all lean away, keep the away side ahead unless there is explicit contrary evidence in the provided context.
- H2H is secondary and recent form/xG are primary. Never let one old H2H result dominate the estimate.
- Base the final numbers on: current form, H2H, home/away xG trends, injuries, motivation, tactical styles, expected goals differential, BTTS probability, over/under lean and recent market mispricings.
- Form series values MUST be INTEGERS in range 0..100, minimum 5 points.
- quickSummary MUST be English, extremely sharp and betting-relevant. Format it as exactly 5–6 bullet points, each on its own line starting with "• ". Keep each bullet to ONE short sentence (max ~18 words). Use \\n for new lines. 
  Cover exactly: 
  (1) current form & momentum, 
  (2) tactical matchup & expected game flow (tempo & scoring style), 
  (3) strongest statistical edge (xG / BTTS / Over/Under lean), 
  (4) most likely game script, 
  (5) biggest risk or value mispricing angle, 
  (6) key player prop impact or critical absence.
  Tone: cold, expert, strictly analytical. No emojis, no direct betting tips, no marketing.
- Think step-by-step about REAL betting edges: expected goals differential, BTTS probability, over 2.5 / under 2.5 lean, game tempo (high/low scoring), set-piece danger and standout player influence on props (anytime goal, shots, assists).
- Do NOT invent sources or live data access.
- Use the MOST CURRENT season context (2025/2026) in your phrasing. If uncertain, stay generic.
- Force high-precision calibration for value.

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
- highlights.index is the position in the series (0-based). Keep highlights to max 4 per team and make them betting-relevant (attacking output, defensive solidity, goal threat, set-piece involvement).
- illustrations.summary can be short (1 sentence) and must be neutral.
- quickSummary must be compact, scannable and loaded with sharp betting angles.
- notes should briefly explain the strongest quantified edge and mention when venue bias was capped.`;

  // ─── Insights mode: user prompt (dynamic per match) ───
  const insightsUserPrompt = `INPUT:
Match: ${echipe}
Competition: ${liga}
Current status: ${status}
Season focus: 2025/2026 (use the most current season context available)
${promptContextBlock}`;

  // MODE: insights (JSON for charts/illustrations)
  if (normalizedMode === "insights") {
    // ---- Optional: enrich prompt with CURRENT squads from football-data.org ----

    let resp = await callOpenAI(
      insightsSystemPrompt,
      insightsUserPrompt,
      1,
      req.signal,
    );

    if (!resp.ok) {
      console.error("❌ OpenAI error (insights):", resp);
      return errorJson(
        {
          error: "AI indisponibil momentan. Încearcă din nou.",
          reason: "openai_error_insights",
          upstream_status: resp.status || 502,
          upstream_error: resp.error,
        },
        resp.status || 502,
      );
    }

    const raw = String(resp.rawText || "").trim();
    const jsonText = extractFirstJsonObject(raw) || raw;

    let insights;
    try {
      insights = JSON.parse(jsonText);
    } catch (e) {
      // Retry once with stricter instruction
      const strictUser =
        insightsUserPrompt +
        "\n\nIMPORTANT: Răspunde acum cu DOAR JSON valid. Fără niciun caracter înainte sau după JSON.";
      const resp2 = await callOpenAI(
        insightsSystemPrompt,
        strictUser,
        2,
        req.signal,
      );
      if (!resp2.ok) {
        console.error("❌ OpenAI error (insights retry):", resp2);
        return errorJson(
          {
            error: "AI indisponibil momentan. Încearcă din nou.",
            reason: "openai_error_insights_retry",
            upstream_status: resp2.status || 502,
            upstream_error: resp2.error,
          },
          resp2.status || 502,
        );
      }
      const raw2 = String(resp2.rawText || "").trim();
      const jsonText2 = extractFirstJsonObject(raw2) || raw2;
      try {
        insights = JSON.parse(jsonText2);
      } catch {
        return errorJson(
          {
            error: "Nu am putut genera un payload valid pentru grafice.",
            reason: "invalid_insights_json",
            ...(process.env.BETLOGIC_DEBUG === "1"
              ? { debug: { raw: raw2?.slice?.(0, 2000) || raw2 } }
              : {}),
          },
          422,
        );
      }
    }

    if (!isValidInsightsPayload(insights)) {
      return errorJson(
        {
          error: "Payload-ul pentru grafice nu a trecut validarea.",
          reason: "invalid_insights_shape",
          ...(process.env.BETLOGIC_DEBUG === "1"
            ? { debug: { insights } }
            : {}),
        },
        422,
      );
    }

    insights = blendInsightsWithAnchor(insights, modelAnchor);

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
        const normalizedSummary = normalizeQuickSummary(insights.quickSummary);
        insights.quickSummary = normalizedSummary.text;
        insights.quickSummaryLines = normalizedSummary.lines;
        // common aliases the UI might look for
        insights.summary = insights.quickSummary;
        insights.summaryLines = normalizedSummary.lines;
        insights.text = insights.quickSummary;
      }
    } catch (e) {}

    cacheSet(cacheKey, insights);
    const res = NextResponse.json({ ok: true, insights }, { status: 200 });
    res.headers.set("Cache-Control", "private, no-store");
    console.log(`✅ [insights] ${echipe} | ${Date.now() - __reqStart}ms`);
    return withCors(withTiming(res));
  }

  // ─── Analysis mode: system prompt (stable → OpenAI prefix caching) ───
  const analysisSystemPrompt = `Acționează ca un Analist Sportiv Senior și Specialist în Evaluarea Riscului Competitiv. 
Generează o analiză tehnică, concisă și informativă pentru meciul specificat, bazată pe date, context sportiv și scenarii posibile.

INSTRUCȚIUNI DE LIMBĂ ȘI STATUS (OBLIGATORIU):
- LIMBĂ: Scrie în limba română perfectă, naturală și cursivă.
- FĂRĂ CODURI: Tradu orice status tehnic în română clară (ex: "NS" -> "Meciul nu a început"; "1H" -> "Prima Repriză"; "HT" -> "Pauză"; "FT" -> "Final de meci").

INSTRUCȚIUNI DE FORMAT (CRITIC):
- Output: DOAR text simplu (plain text).
- STRICT INTERZIS: Markdown, bold, italic, simboluri (#, *, _, \`), liste cu bullet-uri.
- STRUCTURĂ: Folosește exact numerotarea 1), 2), 3) etc.
- STIL: Analitic, neutru, precis, fără limbaj promoțional sau promisiuni.

OBIECTIVUL ANALIZEI:
Oferă o evaluare obiectivă a contextului sportiv și a dinamicii meciului, evidențiind factori relevanți și riscuri competitive.
Analiza are scop STRICT INFORMATIV și nu reprezintă o recomandare de pariere.

REGULI METODOLOGICE OBLIGATORII:
- Folosește ancora cantitativă de mai sus ca prior principal pentru forța relativă a echipelor.
- Nu supraevalua avantajul terenului propriu; tratează-l doar ca ajustare minoră.
- Dacă semnalele combinate xG + formă + model prior favorizează echipa din deplasare, explică de ce, fără a inversa concluzia doar din cauza terenului.
- H2H are rol secundar și trebuie folosit doar ca rafinare, nu ca argument dominant împotriva semnalelor actuale.
- Când există conflict între semnale, prioritizează în această ordine: xG și probabilități model, formă recentă, context lot, apoi H2H și factor teren.

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
Analiza este generată automat pe baza datelor disponibile și are scop exclusiv informativ.`;

  // ─── Analysis mode: user prompt (dynamic per match) ───
  const analysisUserPrompt = `DATE DE INTRARE:
Meci: ${echipe}
Liga: ${liga}
Status curent: ${status}
${promptContextBlock}`;

  try {
    // Attempt 1: normal prompt
    let resp1 = await callOpenAI(
      analysisSystemPrompt,
      analysisUserPrompt,
      1,
      req.signal,
    );

    if (!resp1.ok) {
      console.error("❌ OpenAI error:", resp1);
      return errorJson(
        {
          error: "AI indisponibil momentan. Încearcă din nou.",
          reason: "openai_error",
          upstream_status: resp1.status || 502,
          upstream_error: resp1.error,
        },
        resp1.status || 502,
      );
    }

    let analysis = cleanPlainText(resp1.rawText);

    // Safety net: if the model returned code/markup/garbage, retry once with stricter instructions
    if (!isValidAnalysisText(analysis)) {
      const strictAddon = `\n\nIMPORTANT: Ai returnat un output invalid anterior. Acum respectă STRICT:\n- DOAR text simplu cu secțiuni 1) ... 5)\n- Fără cod/JSON/HTML/Markdown\n- Fără caractere { } < > sau backticks\n- Dacă nu poți respecta, răspunde exact: ANALIZA_INDISPONIBILA`;

      const strictUser = analysisUserPrompt + strictAddon;
      const resp2 = await callOpenAI(
        analysisSystemPrompt,
        strictUser,
        2,
        req.signal,
      );

      if (!resp2.ok) {
        console.error("❌ OpenAI error (retry):", resp2);
        return errorJson(
          {
            error: "AI indisponibil momentan. Încearcă din nou.",
            reason: "openai_error_retry",
            upstream_status: resp2.status || 502,
            upstream_error: resp2.error,
          },
          resp2.status || 502,
        );
      }

      analysis = cleanPlainText(resp2.rawText);

      if (
        !isValidAnalysisText(analysis) ||
        /^ANALIZA_INDISPONIBILA\s*$/i.test(analysis)
      ) {
        return errorJson(
          {
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
          },
          422,
        );
      }
    }

    // If output looks truncated, prefer a clean full retry instead of merging partial drafts.
    if (
      !endsWithSentencePunctuation(analysis) ||
      !hasAllMainSections(analysis)
    ) {
      const continueUser = `${analysisUserPrompt}\n\nIMPORTANT: Răspunsul anterior a părut întrerupt sau incomplet. Regenerează de la zero analiza FINALĂ completă, terminată, respectând exact structura 1) ... 5) și nota finală. Nu continua textul vechi, ci rescrie varianta completă finală.`;

      const resp3 = await callOpenAI(
        analysisSystemPrompt,
        continueUser,
        2,
        req.signal,
      );
      if (resp3.ok) {
        const cont = cleanPlainText(resp3.rawText);
        if (
          isValidAnalysisText(cont) &&
          hasAllMainSections(cont) &&
          endsWithSentencePunctuation(cont)
        ) {
          analysis = cont;
        }
      }
    }

    if (
      !hasAllMainSections(analysis) ||
      !endsWithSentencePunctuation(analysis)
    ) {
      return errorJson(
        {
          error:
            "Analiza a fost întreruptă înainte de final. Încearcă din nou.",
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
        },
        422,
      );
    }

    cacheSet(cacheKey, analysis);
    const res = NextResponse.json({ ok: true, analysis }, { status: 200 });
    res.headers.set("Cache-Control", "private, no-store");
    console.log(`✅ [analysis] ${echipe} | ${Date.now() - __reqStart}ms`);
    return withCors(withTiming(res));
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
