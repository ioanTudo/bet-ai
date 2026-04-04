import { NextResponse } from "next/server";

/* ── In-memory response cache (survives Vercel warm invocations) ── */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _fixturesCache = (globalThis.__fixturesCache ??= new Map());

function getCached(date) {
  const entry = _fixturesCache.get(date);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _fixturesCache.delete(date);
    return null;
  }
  return entry.data;
}

function setCache(date, data) {
  // Evict oldest if too many dates cached
  if (_fixturesCache.size >= 10) {
    const oldest = _fixturesCache.keys().next().value;
    _fixturesCache.delete(oldest);
  }
  _fixturesCache.set(date, { data, ts: Date.now() });
}

/* ── Dedup concurrent requests for the same date ── */
const _inflight = (globalThis.__fixturesInflight ??= new Map());

function withCors(res) {
  const origin = process.env.WP_ORIGIN || "https://betlogic.ro";
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
  return res;
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

const WOMENS_PATTERNS = [
  /\(\s*w\s*\)/i,
  /\(\s*women\s*\)/i,
  /\(\s*f\s*\)/i,
  /\bwomen\b/i,
  /\bwomens\b/i,
  /\bwomen['']s\b/i,
  /\bladies\b/i,
  /\bfemale\b/i,
  /\bfeminin/i,
  /\bfemmin/i,
  /\bfemen/i,
  /\bfrauen\b/i,
  /\bdamen\b/i,
  /\bvrouwen\b/i,
  /\bnwsl\b/i,
  /\bfawsl\b/i,
  /\buwcl\b/i,
  /\bd1\s+arkema\b/i,
  /\bdamallsvenskan\b/i,
  /\bliga\s+f\b/i,
  /\bliga\s+mx\s+femenil\b/i,
];

function isWomensContext(league, home, away) {
  const blob = [league, home, away].filter(Boolean).join(" ");
  if (!blob) return false;
  return WOMENS_PATTERNS.some((re) => re.test(blob));
}

export async function GET(req) {
  if (!process.env.APISPORTS_KEY) {
    console.error("Missing APISPORTS_KEY in environment variables.");
    return withCors(
      NextResponse.json(
        { error: "Missing APISPORTS_KEY", fixtures: [] },
        { status: 500 },
      ),
    );
  }

  const urlObj = new URL(req.url);
  const dateParam = urlObj.searchParams.get("date");
  const date =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : new Date().toISOString().slice(0, 10);

  // 1. Check in-memory cache
  const cached = getCached(date);
  if (cached) {
    const res = NextResponse.json(cached);
    res.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
    res.headers.set("X-Cache", "HIT");
    return withCors(res);
  }

  // 2. Dedup concurrent requests for the same date
  if (_inflight.has(date)) {
    try {
      const data = await _inflight.get(date);
      const res = NextResponse.json(data);
      res.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
      res.headers.set("X-Cache", "DEDUP");
      return withCors(res);
    } catch {
      return withCors(
        NextResponse.json({ date, fixtures: [] }, { status: 200 }),
      );
    }
  }

  // 3. Fetch from API-Sports
  const fetchPromise = (async () => {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(
        date,
      )}`,
      {
        headers: {
          "x-apisports-key": process.env.APISPORTS_KEY,
        },
        cache: "no-store",
      },
    );

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      console.error("API-Football error:", res.status, data);
      return { date, fixtures: [] };
    }

    // Log remaining API quota from response headers
    const remaining = res.headers.get("x-ratelimit-requests-remaining");
    if (remaining !== null && Number(remaining) < 20) {
      console.warn(
        `[meciuri] API-Sports quota low: ${remaining} requests remaining`,
      );
    }

    const fixtures =
      data?.response
        ?.map((fx) => {
          const home = fx?.teams?.home || {};
          const away = fx?.teams?.away || {};
          const league = fx?.league || {};
          const fixture = fx?.fixture || {};

          return {
            match_id: fixture?.id ?? null,
            kickoff: fixture?.date ?? null,
            status_raw: fixture?.status?.short ?? "",

            league_id: league?.id ?? null,
            league: safeStr(league?.name),
            country: safeStr(league?.country),
            league_logo: safeStr(league?.logo),

            home_id: home?.id ?? null,
            home_team: safeStr(home?.name),
            home_logo: safeStr(home?.logo),

            away_id: away?.id ?? null,
            away_team: safeStr(away?.name),
            away_logo: safeStr(away?.logo),

            stadium: safeStr(fixture?.venue?.name),
          };
        })
        .filter(
          (fx) => !isWomensContext(fx.league, fx.home_team, fx.away_team),
        ) || [];

    const result = { date, count: fixtures.length, fixtures };
    setCache(date, result);
    return result;
  })();

  _inflight.set(date, fetchPromise);

  try {
    const result = await fetchPromise;
    const res = NextResponse.json(result);
    res.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
    res.headers.set("X-Cache", "MISS");
    return withCors(res);
  } catch (err) {
    console.error("Server error in /api/meciuri:", err);
    return withCors(NextResponse.json({ date, fixtures: [] }, { status: 200 }));
  } finally {
    _inflight.delete(date);
  }
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  return withCors(res);
}
