"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [games, setGames] = useState([]);
  const [selectedLeague, setSelectedLeague] = useState("All");
  const [selectedMatch, setSelectedMatch] = useState("None");
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/meciuri")
      .then((res) => res.json())
      .then((data) => setGames(data.meciuri || []));
  }, []);

  const leagues = ["All", ...new Set(games.map((g) => g.liga))];

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

    const res = await fetch("/api/analiza", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selectedMatchDetails),
    });

    const data = await res.json();
    console.log("✅ Analiza API:", data);
    setAnalysis(data.analysis || data.error || "No analysis returned.");
    setLoading(false);
  };

  return (
    <div style={{ padding: 32, fontFamily: "Arial" }}>
      <h2>⚽ BetChances – AI Match Analysis</h2>

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
