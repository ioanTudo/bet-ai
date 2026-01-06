import { NextResponse } from "next/server";

const INTERNAL_KEY = process.env.BETLOGIC_INTERNAL_KEY;

function stripMarkdownBasic(input = "") {
  // Best-effort cleanup if the model returns Markdown anyway.
  // Keep it conservative: remove common formatting tokens.
  return (
    String(input)
      // code fences
      .replace(/```[\s\S]*?```/g, (m) => {
        // If there is code inside fences, keep only the inner text without the fences
        return m.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, "");
      })
      // inline code
      .replace(/`([^`]+)`/g, "$1")
      // headings like ### Title
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      // bold/italic markers **text** or *text*
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      // blockquotes
      .replace(/^\s{0,3}>\s?/gm, "")
      // list markers (-, *, +, 1.)
      .replace(/^\s{0,3}[-*+]\s+/gm, "")
      .replace(/^\s{0,3}\d+\.\s+/gm, "")
      // stray markdown chars
      .replace(/[\*_#`]+/g, "")
      // trim excessive blank lines
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

  const prompt = `Ești un analist profesionist de pariuri sportive (fotbal). Scrie o analiză clară, structurată și prudentă, în limba română, pentru meciul de mai jos.

IMPORTANT – FORMAT OUTPUT
- Returnează EXCLUSIV TEXT SIMPLU (plain text).
- NU folosi Markdown și NU folosi caractere de formatare precum: #, *, **, _, backticks (\`), liste cu "-" sau "•".
- Nu include titluri cu # sau orice marcaj de tip markdown.
- Folosește doar propoziții normale și separatoare simple (ex: linii goale) și etichete cu „:”.

DATE MECI
Meci: ${echipe}
Ligă/Competiție: ${liga}
Status: ${status}

CERINȚE
- Fără promisiuni de câștig și fără limbaj de tip „sigur/garantat”.
- Dacă nu ai suficiente informații, spune explicit ce lipsește și oferă o analiză bazată pe principii generale, fără a inventa date.
- Dacă status este LIVE, adaptează analiza pentru context live (ritm, risc crescut, volatilitate).

STRUCTURĂ (în această ordine, cu etichete și text normal)

Rezumat rapid:
2–4 propoziții despre context și ce ar trebui urmărit.

Context și dinamică:
Explică tipul meciului (campionat/cupă/amical), posibile motivații, ritm așteptat și un scenariu probabil de joc.

Factori cheie:
Menționează 3–6 factori care pot influența decisiv meciul (tactic, ritm, gol timpuriu, cartonaș roșu, rotații, oboseală etc.).

Evaluarea riscului:
Alege un nivel (Scăzut / Mediu / Ridicat) și explică în 1–2 propoziții.

Direcție probabilă:
Concluzie argumentată despre direcția probabilă (ex: ușor avantaj pentru una dintre echipe, meci echilibrat, profil de under/over), fără procente inventate.

Unghiuri de pariere:
Oferă 1–3 idei rezonabile, în ordinea preferinței. Pentru fiecare: de ce, condiții de validare și când nu.

Notă de responsabilitate:
O singură propoziție că analiza este informativă și nu reprezintă sfat financiar.
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

    analysis = analysis.trim();

    // Safety net: if the model returns Markdown anyway, normalize to plain text.
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
