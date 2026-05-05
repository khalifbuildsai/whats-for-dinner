import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function POST(req: Request) {
  const { ingredients } = await req.json();
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return NextResponse.json({ error: "ingredients required" }, { status: 400 });
  }

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `I have these ingredients in my fridge: ${ingredients.join(", ")}.

Suggest one realistic recipe I can make right now. Pick something genuinely good — not just whatever uses the most ingredients. Assume I have basic pantry staples (salt, pepper, oil, water, flour, sugar). The recipe should be a real dish with:
- a short, appealing title (2-4 words)
- a one-sentence description
- realistic total minutes
- realistic serving count (1-4)
- the ingredients used (only from my list plus pantry basics)
- clear, concise numbered steps (each step one short sentence)`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          recipe: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              minutes: { type: Type.NUMBER },
              serves: { type: Type.NUMBER },
              ingredients: { type: Type.ARRAY, items: { type: Type.STRING } },
              steps: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: [
              "title",
              "description",
              "minutes",
              "serves",
              "ingredients",
              "steps",
            ],
          },
        },
        required: ["recipe"],
      },
    },
  });

  const text = response.text ?? "{}";
  const parsed = JSON.parse(text);
  return NextResponse.json(parsed);
}
