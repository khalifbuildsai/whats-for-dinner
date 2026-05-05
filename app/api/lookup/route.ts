import { NextResponse } from "next/server";

export const runtime = "nodejs";

const cache = new Map<string, { ingredient: string | null; ts: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

const GENERIC_BLOCK = new Set([
  "en:foods",
  "en:meals",
  "en:plant-based-foods",
  "en:plant-based-foods-and-beverages",
  "en:dairies",
  "en:fats",
  "en:condiments",
  "en:sauces",
  "en:snacks",
  "en:sweet-snacks",
  "en:salty-snacks",
  "en:desserts",
  "en:groceries",
  "en:fermented-foods",
  "en:fermented-milk-products",
  "en:dairy-desserts",
  "en:meats",
  "en:fishes",
  "en:seafood",
  "en:processed-foods",
]);

// Categories we never want to surface as recipe ingredients (drinks, candy, etc.).
const REJECT = new Set([
  "en:beverages",
  "en:beverages-and-juices",
  "en:non-alcoholic-beverages",
  "en:alcoholic-beverages",
  "en:waters",
  "en:carbonated-drinks",
  "en:sodas",
  "en:colas",
  "en:fruit-juices",
  "en:juices",
  "en:nectars",
  "en:smoothies",
  "en:energy-drinks",
  "en:sports-drinks",
  "en:teas",
  "en:coffees",
  "en:beers",
  "en:wines",
  "en:spirits",
  "en:cocktails",
  "en:candies",
  "en:chocolates",
  "en:cookies",
  "en:biscuits",
  "en:chips-and-fries",
  "en:crisps",
  "en:potato-chips",
  "en:ice-creams",
  "en:cereals",
  "en:breakfast-cereals",
  "en:cereal-bars",
]);

const REMAP: Record<string, string> = {
  "en:hens-eggs": "eggs",
  "en:chicken-eggs": "eggs",
  "en:eggs": "eggs",
  "en:milks": "milk",
  "en:whole-milks": "milk",
  "en:semi-skimmed-milks": "milk",
  "en:skimmed-milks": "skim milk",
  "en:plant-based-milks": "milk",
  "en:oat-milks": "oat milk",
  "en:almond-milks": "almond milk",
  "en:soy-milks": "soy milk",
  "en:yogurts": "yogurt",
  "en:greek-yogurts": "greek yogurt",
  "en:plain-yogurts": "yogurt",
  "en:butters": "butter",
  "en:salted-butters": "butter",
  "en:unsalted-butters": "butter",
  "en:cheeses": "cheese",
  "en:cheddars": "cheddar",
  "en:mozzarellas": "mozzarella",
  "en:parmesans": "parmesan",
  "en:fetas": "feta",
  "en:cream-cheeses": "cream cheese",
  "en:creams": "cream",
  "en:heavy-creams": "heavy cream",
  "en:sour-creams": "sour cream",
  "en:bread": "bread",
  "en:breads": "bread",
  "en:tortillas": "tortillas",
  "en:pastas": "pasta",
  "en:fresh-pastas": "pasta",
  "en:rices": "rice",
  "en:white-rices": "rice",
  "en:brown-rices": "brown rice",
  "en:olive-oils": "olive oil",
  "en:vegetable-oils": "vegetable oil",
  "en:soy-sauces": "soy sauce",
  "en:ketchups": "ketchup",
  "en:mustards": "mustard",
  "en:mayonnaises": "mayonnaise",
  "en:hot-sauces": "hot sauce",
  "en:salsas": "salsa",
  "en:tomato-sauces": "tomato sauce",
  "en:pasta-sauces": "pasta sauce",
  "en:peanut-butters": "peanut butter",
  "en:jams": "jam",
  "en:honeys": "honey",
  "en:maple-syrups": "maple syrup",
  "en:flours": "flour",
  "en:wheat-flours": "flour",
  "en:sugars": "sugar",
  "en:chicken-breasts": "chicken breast",
  "en:chicken-thighs": "chicken thigh",
  "en:chickens": "chicken",
  "en:ground-beefs": "ground beef",
  "en:beefs": "beef",
  "en:porks": "pork",
  "en:bacons": "bacon",
  "en:sausages": "sausage",
  "en:salmon": "salmon",
  "en:tunas": "tuna",
  "en:tofus": "tofu",
  "en:hummus": "hummus",
  "en:pestos": "pesto",
  "en:olives": "olives",
  "en:pickles": "pickles",
};

function cleanTag(tag: string): string | null {
  const stripped = tag.replace(/^en:/, "").replace(/-/g, " ").trim();
  if (!stripped || stripped.length > 30) return null;
  if (/^\d/.test(stripped)) return null;
  return stripped;
}

function pickIngredient(tags: string[]): string | null {
  // Reject the whole product if any tag is in REJECT (drinks, candy, etc.).
  for (const tag of tags) {
    if (REJECT.has(tag)) return null;
  }
  // Only consider English tags so we don't return e.g. "fr:pates a tartiner".
  const enTags = tags.filter((t) => t.startsWith("en:"));
  for (let i = enTags.length - 1; i >= 0; i--) {
    const tag = enTags[i];
    if (GENERIC_BLOCK.has(tag)) continue;
    if (REMAP[tag]) return REMAP[tag];
  }
  for (let i = enTags.length - 1; i >= 0; i--) {
    const tag = enTags[i];
    if (GENERIC_BLOCK.has(tag)) continue;
    const cleaned = cleanTag(tag);
    if (cleaned) return cleaned;
  }
  return null;
}

export async function POST(req: Request) {
  const { barcode } = await req.json();
  if (typeof barcode !== "string" || !/^\d{6,14}$/.test(barcode)) {
    return NextResponse.json({ error: "barcode required" }, { status: 400 });
  }

  const cached = cache.get(barcode);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json({ ingredient: cached.ingredient });
  }

  let ingredient: string | null = null;
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=categories_tags,generic_name`,
      {
        headers: {
          "User-Agent": "FridgeScan/1.0 (open-source recipe app)",
        },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        status?: number;
        product?: { categories_tags?: string[] };
      };
      if (data.status === 1 && data.product) {
        const tags = data.product.categories_tags ?? [];
        ingredient = pickIngredient(tags);
      }
    }
  } catch {
    // network/timeout — leave ingredient null
  }

  cache.set(barcode, { ingredient, ts: Date.now() });
  return NextResponse.json({ ingredient });
}
