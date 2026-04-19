"use client";
import { useEffect, useEffectEvent, useState } from "react";
import Link from "next/link";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function formatLocalDate(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getBrowserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function normalizeGame(game) {
  const homeTeam = String(game?.home_team || "").trim();
  const awayTeam = String(game?.away_team || "").trim();

  return {
    ...game,
    liga: String(game?.liga || game?.league || "").trim(),
    echipe:
      String(game?.echipe || "").trim() ||
      [homeTeam, awayTeam].filter(Boolean).join(" vs "),
    status: String(game?.status || game?.status_raw || "").trim(),
  };
}

export default function Home() {
  const [games, setGames] = useState([]);
  const [loadedDate, setLoadedDate] = useState("");

  const loadGames = useEffectEvent(async (forcedDate) => {
    const currentDate = forcedDate || formatLocalDate();
    const timeZone = getBrowserTimeZone();

    try {
      const res = await fetch(
        `/api/meciuri?date=${encodeURIComponent(currentDate)}`,
        {
          cache: "no-store",
          headers: timeZone ? { "x-timezone": timeZone } : undefined,
        },
      );
      const data = await res.json();
      const nextGames = (data.fixtures || data.meciuri || []).map(normalizeGame);

      setGames(nextGames);
      setLoadedDate(data.date || currentDate);
    } catch {
      setGames([]);
      setLoadedDate(currentDate);
    }
  });

  useEffect(() => {
    const refreshGames = () => loadGames(formatLocalDate());
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshGames();
      }
    };

    refreshGames();

    const intervalId = window.setInterval(refreshGames, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshGames);
    window.addEventListener("pageshow", refreshGames);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshGames);
      window.removeEventListener("pageshow", refreshGames);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const leagueMap = new Map();
  for (const g of games) {
    if (!g.liga) continue;
    if (!leagueMap.has(g.liga)) {
      leagueMap.set(g.liga, { name: g.liga, logo: g.league_logo, country: g.country, count: 0 });
    }
    leagueMap.get(g.liga).count++;
  }
  const leagueGroups = [...leagueMap.values()];

  return (
    <div style={{ padding: 32, fontFamily: "Arial", maxWidth: 700 }}>
      <h2>⚽ BetChances – Daily Matches</h2>
      {loadedDate && (
        <p style={{ marginTop: 4, color: "#555" }}>
          Matches for <strong>{loadedDate}</strong> · {games.length} total
        </p>
      )}

      <Link
        href={loadedDate ? `/popular?date=${loadedDate}` : "/popular"}
        style={{
          display: "inline-block",
          marginTop: 16,
          marginBottom: 24,
          padding: "10px 20px",
          background: "#f0a500",
          color: "#fff",
          borderRadius: 8,
          fontWeight: "bold",
          textDecoration: "none",
          fontSize: 15,
        }}
      >
        ⭐ Popular Matches
      </Link>

      <div style={{ marginTop: 8 }}>
        {leagueGroups.length === 0 && (
          <p style={{ color: "#999" }}>Loading leagues…</p>
        )}
        {leagueGroups.map((league) => (
          <Link
            key={league.name}
            href={`/liga?name=${encodeURIComponent(league.name)}&date=${loadedDate}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              marginBottom: 6,
              border: "1px solid #e0e0e0",
              borderRadius: 8,
              textDecoration: "none",
              color: "#111",
              background: "#fafafa",
            }}
          >
            {league.logo && (
              <img src={league.logo} alt="" width={22} height={22} style={{ objectFit: "contain" }} />
            )}
            <span style={{ flex: 1, fontWeight: 500 }}>{league.name}</span>
            {league.country && (
              <span style={{ color: "#888", fontSize: 13 }}>{league.country}</span>
            )}
            <span style={{ color: "#aaa", fontSize: 13 }}>{league.count} matches</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
