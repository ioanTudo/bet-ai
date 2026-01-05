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

export async function GET() {
  if (!process.env.APISPORTS_KEY) {
    console.error("Missing APISPORTS_KEY in environment variables.");
    return withCors(
      NextResponse.json(
        { error: "Missing APISPORTS_KEY", meciuri: [] },
        { status: 500 }
      )
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}`,
      {
        headers: {
          "x-apisports-key": process.env.APISPORTS_KEY,
        },
        cache: "no-store",
      }
    );

    const data = await res.json();

    if (!res.ok) {
      console.error("API-Football error:", res.status, data);
      return withCors(NextResponse.json({ meciuri: [] }, { status: 200 }));
    }

    const meciuri =
      data.response?.map((fx) => ({
        echipe: `${fx.teams.home.name} vs ${fx.teams.away.name}`,
        liga: fx.league.name,
        status: fx.fixture.status.short,
      })) || [];

    return withCors(NextResponse.json({ meciuri }));
  } catch (err) {
    console.error("Server error in /api/meciuri:", err);
    return withCors(NextResponse.json({ meciuri: [] }, { status: 200 }));
  }
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  return withCors(res);
}
