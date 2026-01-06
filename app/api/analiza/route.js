import { NextResponse } from "next/server";

const INTERNAL_KEY = process.env.BETLOGIC_INTERNAL_KEY;

function stripMarkdownBasic(text) {
  if (!text) return "";
  return (
    String(text)
      // remove code fences
      .replace(/```[\s\S]*?```/g, (m) => {
        // keep code content but remove the fences
        return m.replace(/```\w*\n?/g, "").replace(/```/g, "");
      })
      // remove inline code backticks
      .replace(/`+/g, "")
      // headings like ###
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      // bold/italic markers
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+ toggle?)_/g, "$1")
      // list markers at line start
      .replace(/^\s*[-*+]\s+/gm, "")
      // numbered lists like 1)
      .replace(/^\s*\d+\)\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      // remove stray markdown blockquote markers
      .replace(/^\s*>\s?/gm, "")
      // collapse excessive blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
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

  const prompt = `Ești un analist profesionist de fotbal și redactezi o analiză informativă pentru pariori.

IMPORTANT (FORMAT):
- Scrie EXCLUSIV în text simplu (plain text). NU folosi Markdown.
- NU folosi caractere de tip: #, *, **, _, \`, liste cu '-' sau '*' și NU folosi blocuri de cod.
- Folosește titluri simple scrise ca text normal, urmate de ':' și apoi paragrafe scurte.
- Separă secțiunile printr-o linie goală.
- Fără promisiuni de câștig și fără limbaj de tip „sigur/garantat”.
- Dacă nu ai suficiente date, spune clar ce lipsește și oferă o analiză bazată pe principii generale, fără a inventa statistici.
- Nu inventa procente.

DATE MECI:
Meci: ${echipe}
Competiție: ${liga}
Status: ${status}

STRUCTURĂ CERUTĂ:
1. Rezumat rapid: 2-4 propoziții cu ideea principală.
2. Context și dinamică: tipul meciului (campionat/cupă/amical), motivație posibilă, ritm probabil.
3. Factori cheie: 4-7 puncte scrise ca propoziții separate (fără bullet points), despre tactică, ritm, rotații, risc de cartonașe etc.
4. Evaluarea riscului: alege un nivel (Scăzut / Mediu / Ridicat) și explică scurt.
5. Direcție probabilă: concluzie argumentată, fără procente.
6. Unghiuri de pariere: 1-3 opțiuni „reasonable”, fiecare cu:
   - Ce: (ex: Dublă șansă, Under/Over, Ambele marchează etc.)
   - De ce: 1-2 propoziții
   - Când are sens: condiții de validare
   - Când NU: semnale clare de evitare
7. Notă: o propoziție că este conținut informativ, nu sfat financiar.

Răspunde doar cu analiza, fără introduceri despre rolul tău.`;

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
        max_tokens: 350,
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

    analysis = analysis.trim();
    analysis = stripMarkdownBasic(analysis);

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
