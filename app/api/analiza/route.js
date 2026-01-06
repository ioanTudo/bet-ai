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

DATE MECI
- Meci: ${echipe}
- Ligă/Competiție: ${liga}
- Status: ${status}

CERINȚE DE OUTPUT (format)
- Răspunsul trebuie să fie în **Markdown**, cu titluri și bullet points.
- Fără promisiuni de câștig și fără limbaj de tip „sigur/garantat”.
- Dacă nu ai suficiente informații, spune explicit ce lipsește și oferă o analiză bazată pe principii generale, fără a inventa date.

1) Rezumat rapid (2–4 propoziții)
- Contextul meciului și ce ar trebui să urmărească un parior.

2) Context & dinamică
- Tipul meciului (campionat/cupă/amical), posibile motivații (clasament/obiective), ritm așteptat.
- Scenariu probabil de joc (echipă care va controla posesia, tranziții, presing, bloc jos etc.).

3) Factori cheie (bullet points)
- Avantaje/dezavantaje tactice probabile.
- Elemente care pot schimba meciul (gol timpuriu, cartonaș roșu, oboseală, rotații).
- Impactul statusului (${status}) asupra interpretării (dacă este LIVE, cum se schimbă riscul față de pre-match).

4) Evaluarea riscului
- Alege un nivel: **Scăzut / Mediu / Ridicat**.
- Explică pe scurt de ce.

5) Direcție probabilă (fără procente inventate)
- Concluzie argumentată despre direcția probabilă (ex: echipa A are ușor avantaj, meci echilibrat, profil de under/over etc.).

6) Unghiuri de pariere (1–3 opțiuni)
- Oferă 1–3 idei „reasonable”, în ordinea preferinței, de tip:
  - rezultat (1X2 sau dublă șansă),
  - goluri (under/over),
  - ambele marchează,
  - handicap asiatic (doar dacă are sens),
  - pentru LIVE: next goal / under în repriza curentă etc.
- Pentru fiecare opțiune, include:
  - **De ce** (argument),
  - **Condiții de validare** (ce trebuie să fie adevărat ca bet-ul să aibă sens),
  - **Când NU** (semnale de evitând pariul).

7) Notă de responsabilitate (1 propoziție)
- Menționează că analiza este informativă și nu reprezintă sfat financiar.
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
