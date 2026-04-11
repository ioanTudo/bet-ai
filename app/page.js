"use client";
import { useEffect, useEffectEvent, useState } from "react";

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
  const [selectedLeague, setSelectedLeague] = useState("All");
  const [selectedMatch, setSelectedMatch] = useState("None");
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
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

  const leagues = ["All", ...new Set(games.map((g) => g.liga).filter(Boolean))];

  const gamesByLeague =
    selectedLeague === "All"
      ? games
      : games.filter((g) => g.liga === selectedLeague);

  const matchesInLeague = [
    "None",
    ...new Set(gamesByLeague.map((g) => g.echipe)),
  ];

  const selectedMatchDetails =
    selectedMatch === "None"
      ? null
      : gamesByLeague.find((g) => g.echipe === selectedMatch);

  const analyze = async () => {
    if (!selectedMatchDetails) return;

    setLoading(true);
    setAnalysis(null);

    try {
      const res = await fetch("/api/analiza", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(selectedMatchDetails),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          String(data?.error || data?.reason || `Request failed (${res.status})`),
        );
      }

      setAnalysis(data?.analysis || data?.error || "No analysis returned.");
    } catch (error) {
      setAnalysis(
        error instanceof Error
          ? error.message
          : "Could not generate the analysis.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 32, fontFamily: "Arial" }}>
      <h2>⚽ BetChances – AI Match Analysis</h2>
      {loadedDate && (
        <p style={{ marginTop: 8, color: "#555" }}>
          Showing matches for <strong>{loadedDate}</strong>
        </p>
      )}

      <label>
        League:
        <select
          value={selectedLeague}
          onChange={(e) => {
            setSelectedLeague(e.target.value);
            setSelectedMatch("None");
            setAnalysis(null);
          }}
        >
          {leagues.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>

      {selectedLeague !== "All" && (
        <label style={{ marginLeft: 16 }}>
          Match:
          <select
            value={selectedMatch}
            onChange={(e) => {
              setSelectedMatch(e.target.value);
              setAnalysis(null);
            }}
          >
            {matchesInLeague.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      )}

      {selectedMatchDetails && (
        <div style={{ marginTop: 24 }}>
          <p>
            <strong>{selectedMatchDetails.echipe}</strong>
          </p>
          <p>Status: {selectedMatchDetails.status}</p>

          <button onClick={analyze} disabled={loading}>
            {loading ? "Analyzing..." : "Analyze with AI"}
          </button>

          {analysis && (
            <div style={{ marginTop: 16, background: "#f5f5f5", padding: 16 }}>
              <h4>📊 AI Analysis</h4>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                {analysis}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
