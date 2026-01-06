import { NextResponse } from "next/server";

function withCors(res) {
  const origin = process.env.WP_ORIGIN || "*"; // set WP_ORIGIN in prod to your WP domain
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  return res;
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export async function GET(req) {
  if (!process.env.APISPORTS_KEY) {
    console.error("Missing APISPORTS_KEY in environment variables.");
    return withCors(
      NextResponse.json(
        { error: "Missing APISPORTS_KEY", fixtures: [] },
        { status: 500 }
      )
    );
  }

  const urlObj = new URL(req.url);
  const dateParam = urlObj.searchParams.get("date");
  const date =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : new Date().toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(
        date
      )}`,
      {
        headers: {
          "x-apisports-key": process.env.APISPORTS_KEY,
        },
        cache: "no-store",
      }
    );

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      console.error("API-Football error:", res.status, data);
      return withCors(
        NextResponse.json({ date, fixtures: [] }, { status: 200 })
      );
    }

    const fixtures =
      data?.response?.map((fx) => {
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
      }) || [];

    return withCors(
      NextResponse.json({ date, count: fixtures.length, fixtures })
    );
  } catch (err) {
    console.error("Server error in /api/meciuri:", err);
    return withCors(NextResponse.json({ date, fixtures: [] }, { status: 200 }));
  }
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  return withCors(res);
}

console.log("ENV CHECK:", {
  APISPORTS_KEY: !!process.env.APISPORTS_KEY,
  OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
});
