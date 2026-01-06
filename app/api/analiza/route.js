import { NextResponse } from "next/server";

const INTERNAL_KEY = process.env.BETLOGIC_INTERNAL_KEY;

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

  const prompt = `Acționează ca un Senior Risk Manager și Analist Sportiv de elită. Generează o analiză tehnică, ultra-concisă și orientată strict pe profitabilitate și risc pentru meciul specificat.

  INSTRUCȚIUNI DE FORMAT (CRITIC):
  - Output: DOAR text simplu (plain text).
  - STRICT INTERZIS: Markdown, bold, italic, simboluri (#, *, _), liste cu bullet-uri (folosește "1)", "2)" etc).
  - STIL: Profesional, chirurgical, fără cuvinte de umplutură. Densitate mare de informație în puține cuvinte.
  - NU inventa statistici. Dacă lipsesc datele, bazează-te pe arhetipul echipelor și dinamica ligii.
  
  DATE INTRARE:
  Meci: ${echipe}
  Liga: ${liga}
  Status: ${status} (Interpretează: LIVE, PRE-MATCH sau FINAL în funcție de cod).
  
  STRUCTURA ANALIZEI:
  
  1. CONTEXT ȘI MIZE:
  Maximum 2 fraze. Ce tip de meci este (derby, luptă la retrogradare, relaxare)? Cum influențează motivația?
  
  2. DINAMICA TACTICĂ (Esentia analizei):
  Explică scurt "match-up-ul":
  - Dacă e LIVE: Ce spune scorul/timpul despre urgența tactică? Cine forțează, cine se apără supraaglomerat?
  - Dacă e PRE-MATCH: Stil vs Stil (ex: Posesie vs Contraatac). Unde e dezechilibrul?
  - Dacă e FINAL: Ce factor a decis meciul (eroare, dominare, tactic)?
  
  3. PUNCTE CRITICE DE INTERES:
  Enumeră numerotat 1), 2), 3) cei mai importanți factori care pot "rupe" meciul (ex: oboseală minutul 70, vulnerabilitate pe flancuri, istoric de cartonașe, presiunea publicului).
  
  4. SCENARII PROBABILE:
  Scurt și la obiect.
  A) Scenariu Principal: Ce este cel mai logic să se întâmple.
  B) Scenariu de Risc: Ce ar putea da totul peste cap.
  
  5. RECOMANDARE (UNGHIURI DE PARIERE):
  Oferă 2 direcții clare, bazate pe valoare, nu pe siguranță oarbă.
  Format:
  1) Selecție principală: [Tip pariu] - [Motiv în 5 cuvinte]
  2) Selecție alternativă/Live: [Tip pariu] - [Condiție necesară]
  
  NIVEL DE RISC: Scăzut / Mediu / Ridicat (Argumentează într-o propoziție).
  `;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

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
        model: "mistralai/mistral-7b-instruct",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const contentType = r.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await r.text();
      return withCors(
        NextResponse.json(
          { error: "Non-JSON response from OpenRouter", raw: text },
          { status: 502 }
        )
      );
    }

    const data = await r.json();

    if (!r.ok) {
      console.error("❌ OpenRouter error:", data);
      return withCors(
        NextResponse.json(
          {
            error: data?.error?.message || "OpenRouter request failed",
            raw: data,
          },
          { status: r.status }
        )
      );
    }

    let analysis = data?.choices?.[0]?.message?.content;

    if (!analysis) {
      console.error("⚠️ No AI content:", data);
      return withCors(
        NextResponse.json(
          { error: "No AI content returned", raw: data },
          { status: 500 }
        )
      );
    }

    analysis = cleanPlainText(analysis);

    return withCors(NextResponse.json({ analysis }));
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
