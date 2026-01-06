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

  const prompt = `Ești un analist profesionist de pariuri sportive (fotbal). Scrie o analiză clară, structurată și prudentă, în limba română, pentru meciul de mai jos.

IMPORTANT (format):
- Răspunsul trebuie să fie DOAR text simplu (plain text).
- NU folosi deloc Markdown și NU folosi simboluri de tip: #, ##, ###, *, **, _, __, \`, >, [ ], ( ).
- NU folosi liste cu bullet-uri marcate cu '-' sau '•'. Dacă ai nevoie de listă, folosește numerotare simplă: 1), 2), 3).
- Folosește paragrafe scurte și subtitluri simple scrise ca text normal (ex: "Rezumat", "Context", "Factori cheie"), urmate de două puncte.
- Fără promisiuni de câștig și fără limbaj de tip „sigur/garantat”.
- Dacă nu ai suficiente informații, spune explicit ce lipsește și oferă o analiză bazată pe principii generale, fără a inventa date.

DATE MECI:
Meci: ${echipe}
Liga/Competiție: ${liga}
Status: ${status}

STRUCTURĂ CERUTĂ:

Rezumat:
Scrie 2–4 propoziții despre contextul meciului și ce ar trebui să urmărească un parior.

Context și dinamică:
Explică tipul meciului (campionat/cupă/amical), posibile motivații (clasament/obiective) și ritmul așteptat. Descrie pe scurt un scenariu probabil de joc (posesie, tranziții, pressing, bloc jos etc.).

Factori cheie:
Scrie 4–6 puncte numerotate (1)–(6) cu avantaje/dezavantaje tactice probabile și elemente care pot schimba meciul (gol timpuriu, cartonaș roșu, oboseală, rotații). Include și cum influențează statusul (${status}) interpretarea (dacă e LIVE, cum se schimbă riscul față de pre-match).

Evaluarea riscului:
Alege un nivel: Scăzut / Mediu / Ridicat. Explică pe scurt de ce.

Direcție probabilă:
O concluzie argumentată despre direcția probabilă (ex: echipa A are ușor avantaj, meci echilibrat, profil under/over). NU inventa procente.

Unghiuri de pariere:
Oferă 1–3 opțiuni numerotate 1)–3), în ordinea preferinței. Pentru fiecare opțiune include:
Motiv: de ce are sens.
Condiții: ce trebuie să fie adevărat ca pariul să aibă sens.
Evită dacă: semnale clare că pariul nu e bun.

Notă:
O propoziție că analiza este informativă și nu reprezintă sfat financiar.`;

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
