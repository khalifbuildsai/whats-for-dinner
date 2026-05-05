import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function POST(req: Request) {
  const { image } = await req.json();
  if (typeof image !== "string") {
    return NextResponse.json({ error: "image required" }, { status: 400 });
  }

  const base64 = image.replace(/^data:image\/\w+;base64,/, "");

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "List the raw cooking ingredients you can clearly see in this photo — items someone would actually use to cook. The photo may show a full fridge, a single item held up to the camera, or anything in between; treat all three the same way. Use common simple names ('eggs', 'milk', 'butter', 'chicken', 'spinach', 'soy sauce', 'cheddar'). ONLY include: fresh produce, raw meat/poultry/seafood (incl. shrink-wrapped trays of raw chicken, beef, pork, fish), dairy, eggs, condiments, sauces, basic staples. EXCLUDE: prepared beverages (soda, juice, beer, wine, cocktails, water, sports drinks), packaged snacks (chips, cookies, candy), unmarked leftovers, and items you cannot clearly identify. CRITICAL: Each packaged product counts as ONE ingredient — the product type itself (e.g. 'sausage', 'yogurt', 'hot sauce', 'hummus', 'chicken breast', 'ground beef'). A tray of raw chicken is 'chicken' (or 'chicken breast' / 'chicken thigh' if obvious), NOT a list of what's printed on the label. NEVER transcribe the ingredient list printed on the back or side of a package; ignore that text entirely. NEVER read flavor names, brand names, or marketing text off labels. Identify a package only by what kind of food it is. If unsure about an item, leave it out — it is better to miss something than to invent it.",
          },
          { inlineData: { mimeType: "image/jpeg", data: base64 } },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          ingredients: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ["ingredients"],
      },
    },
  });

  const text = response.text ?? '{"ingredients":[]}';
  const parsed = JSON.parse(text) as { ingredients: string[] };
  const seen = new Set<string>();
  const ingredients = (parsed.ingredients ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });

  return NextResponse.json({ ingredients });
}
