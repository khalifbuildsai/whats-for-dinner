"use client";

import { useEffect, useRef, useState } from "react";
import {
  FREE_DAILY_LIMIT,
  getTodayCount,
  incrementToday,
  remainingToday,
} from "./lib/usage";

type Recipe = {
  title: string;
  description: string;
  minutes: number;
  serves: number;
  ingredients: string[];
  steps: string[];
};

type Phase = "scan" | "loading" | "recipe";

interface DetectedBarcode {
  rawValue: string;
  format: string;
}
interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const CAPTURE_INTERVAL_MS = 2500;
const MAX_WIDTH = 640;
const VOTE_WINDOW = 3;
const VOTE_THRESHOLD = 2;
const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const FOOD_EMOJI = [
  "🦃", "🍇", "🥕", "🍅", "🥦", "🥑", "🍓", "🍋", "🌽", "🥖",
  "🧀", "🥚", "🥩", "🐟", "🦐", "🍗", "🥬", "🍆", "🍄", "🌶️",
  "🥒", "🍑", "🍌", "🍎", "🍐", "🥝", "🍊", "🥯", "🥐", "🍞",
  "🥗", "🍯", "🥔", "🧅", "🧄", "🥥", "🍍", "🥭", "🍒", "🫐",
];

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inFlightRef = useRef(false);
  const recentFramesRef = useRef<string[][]>([]);
  const blockedRef = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ingredientsRef = useRef<string[]>([]);
  const barcodeDetectorRef = useRef<BarcodeDetectorLike | null>(null);
  const barcodeCacheRef = useRef<Map<string, string | null>>(new Map());
  const barcodeInFlightRef = useRef<Set<string>>(new Set());
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [phase, setPhase] = useState<Phase>("scan");
  const [scanning, setScanning] = useState(false);
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [saved, setSaved] = useState(false);
  const [lastCaptured, setLastCaptured] = useState<string[]>([]);
  const [flash, setFlash] = useState(false);
  const [usageCount, setUsageCount] = useState(0);
  const [isPaid] = useState(false); // TODO: wire to real billing later
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [loadingEmoji, setLoadingEmoji] = useState(FOOD_EMOJI[0]);

  useEffect(() => {
    setUsageCount(getTodayCount());
  }, []);

  const remaining = remainingToday(isPaid);
  const atLimit = !isPaid && remaining <= 0;

  async function startCamera() {
    if (streamRef.current) return;
    setError(null);
    try {
      ensureAudio();
      ensureBarcodeDetector();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.play().catch(() => {
          // Interrupted by a new load (re-render, unmount, restart) — safe to ignore.
        });
      }
      setScanning(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Camera access denied");
    }
  }

  function ensureBarcodeDetector() {
    if (barcodeDetectorRef.current) return;
    type WindowWithDetector = Window & {
      BarcodeDetector?: BarcodeDetectorCtor;
    };
    const Ctor = (window as WindowWithDetector).BarcodeDetector;
    if (!Ctor) return;
    try {
      barcodeDetectorRef.current = new Ctor({ formats: BARCODE_FORMATS });
    } catch {
      // unsupported formats; skip silently
    }
  }

  function ensureAudio() {
    if (audioCtxRef.current) return;
    type WindowWithWebkitAudio = Window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx =
      window.AudioContext ||
      (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!Ctx) return;
    audioCtxRef.current = new Ctx();
  }

  function playDing() {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    gain.connect(ctx.destination);

    const a = ctx.createOscillator();
    a.type = "sine";
    a.frequency.setValueAtTime(880, now);
    a.connect(gain);
    a.start(now);
    a.stop(now + 0.34);

    const b = ctx.createOscillator();
    b.type = "sine";
    b.frequency.setValueAtTime(1318.5, now + 0.07);
    const bGain = ctx.createGain();
    bGain.gain.setValueAtTime(0, now);
    bGain.gain.linearRampToValueAtTime(0.16, now + 0.08);
    bGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    b.connect(bGain);
    bGain.connect(ctx.destination);
    b.start(now + 0.07);
    b.stop(now + 0.36);
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(captureAndDetect, CAPTURE_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  useEffect(() => {
    if (phase !== "loading") return;
    setLoadingEmoji(FOOD_EMOJI[Math.floor(Math.random() * FOOD_EMOJI.length)]);
    const id = setInterval(() => {
      setLoadingEmoji(
        FOOD_EMOJI[Math.floor(Math.random() * FOOD_EMOJI.length)],
      );
    }, 350);
    return () => clearInterval(id);
  }, [phase]);

  function addAutoIngredients(candidates: string[]) {
    const current = new Set(ingredientsRef.current);
    const newOnes = candidates.filter(
      (c) => c && !current.has(c) && !blockedRef.current.has(c),
    );
    if (newOnes.length === 0) return;
    const next = [...ingredientsRef.current, ...newOnes];
    ingredientsRef.current = next;
    setIngredients(next);
    setLastCaptured(newOnes);
    setFlash(true);
    if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
    captureTimeoutRef.current = setTimeout(() => {
      setFlash(false);
      setLastCaptured([]);
    }, 1800);
    playDing();
  }

  async function detectVision(dataUrl: string) {
    try {
      const res = await fetch("/api/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { ingredients: string[] };
      const frame = data.ingredients ?? [];

      recentFramesRef.current = [
        ...recentFramesRef.current,
        frame,
      ].slice(-VOTE_WINDOW);

      const counts = new Map<string, number>();
      for (const f of recentFramesRef.current) {
        for (const ing of f) counts.set(ing, (counts.get(ing) ?? 0) + 1);
      }
      const confirmed = [...counts.entries()]
        .filter(([, n]) => n >= VOTE_THRESHOLD)
        .map(([k]) => k);

      if (confirmed.length > 0) addAutoIngredients(confirmed);
    } catch {
      // soft-fail
    }
  }

  async function detectBarcodes(canvas: HTMLCanvasElement) {
    const detector = barcodeDetectorRef.current;
    if (!detector) return;
    let codes: DetectedBarcode[] = [];
    try {
      codes = await detector.detect(canvas);
    } catch {
      return;
    }
    for (const code of codes) {
      const value = code.rawValue;
      if (!/^\d{6,14}$/.test(value)) continue;

      if (barcodeCacheRef.current.has(value)) {
        const cached = barcodeCacheRef.current.get(value);
        if (cached) addAutoIngredients([cached]);
        continue;
      }
      if (barcodeInFlightRef.current.has(value)) continue;
      barcodeInFlightRef.current.add(value);

      try {
        const res = await fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode: value }),
        });
        if (res.ok) {
          const data = (await res.json()) as { ingredient: string | null };
          barcodeCacheRef.current.set(value, data.ingredient);
          if (data.ingredient) addAutoIngredients([data.ingredient]);
        }
      } catch {
        // network hiccup — try again next frame
      } finally {
        barcodeInFlightRef.current.delete(value);
      }
    }
  }

  async function captureAndDetect() {
    if (inFlightRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);

    inFlightRef.current = true;
    try {
      await Promise.all([detectVision(dataUrl), detectBarcodes(canvas)]);
    } finally {
      inFlightRef.current = false;
    }
  }

  function removeIngredient(name: string) {
    blockedRef.current.add(name);
    ingredientsRef.current = ingredientsRef.current.filter((i) => i !== name);
    setIngredients(ingredientsRef.current);
  }

  function addIngredient() {
    const v = adding.trim().toLowerCase();
    if (!v) return;
    blockedRef.current.delete(v);
    if (!ingredientsRef.current.includes(v)) {
      ingredientsRef.current = [...ingredientsRef.current, v];
      setIngredients(ingredientsRef.current);
    }
    setAdding("");
  }

  async function makeRecipe() {
    if (ingredients.length === 0) return;
    if (atLimit) {
      setPaywallOpen(true);
      return;
    }
    stopCamera();
    setError(null);
    setSaved(false);
    setPhase("loading");
    try {
      const res = await fetch("/api/recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingredients }),
      });
      if (!res.ok) throw new Error("Failed to generate recipe");
      const data = (await res.json()) as { recipe: Recipe };
      setRecipe(data.recipe);
      setUsageCount(incrementToday());
      setPhase("recipe");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setPhase("scan");
    }
  }

  function reset() {
    stopCamera();
    recentFramesRef.current = [];
    blockedRef.current = new Set();
    ingredientsRef.current = [];
    setIngredients([]);
    setRecipe(null);
    setError(null);
    setSaved(false);
    setPhase("scan");
  }

  if (phase === "scan") {
    return (
      <main className="mx-auto w-full max-w-md px-5 pt-6 pb-8 flex flex-col gap-5 min-h-dvh">
        <header className="flex items-center justify-between">
          <h1 className="font-display text-3xl">
            What&apos;s for dinner?
          </h1>
        </header>

        {!scanning && (
          <p className="font-display text-2xl text-center leading-tight mt-2">
            Snap your fridge.
            <br />
            Get a recipe.
          </p>
        )}

        <div className="relative rounded-3xl overflow-hidden bg-ink aspect-4/3">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          <canvas ref={canvasRef} className="hidden" />
          {scanning && (
            <div
              className={`pointer-events-none absolute inset-0 rounded-3xl ring-4 ring-accent transition-opacity duration-300 ${
                flash ? "opacity-100" : "opacity-0"
              }`}
            />
          )}
          {!scanning && (
            <button
              onClick={startCamera}
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-cream text-ink border-2 border-dashed border-ink/30 rounded-3xl"
            >
              <CameraIcon />
              <span className="font-display text-2xl">
                tap to scan
              </span>
              <span className="text-[10px] tracking-[0.2em] text-ink-soft uppercase">
                live camera
              </span>
            </button>
          )}
          {scanning && (
            <div className="absolute top-3 left-3 flex items-center gap-2 bg-cream/90 backdrop-blur px-3 py-1.5 rounded-full">
              <span
                className={`w-2 h-2 rounded-full ${
                  flash ? "bg-accent" : "bg-accent animate-pulse"
                }`}
              />
              <span className="font-display text-lg leading-none">
                {flash ? "captured" : "scanning"}
              </span>
            </div>
          )}
          {scanning && (
            <button
              onClick={stopCamera}
              className="absolute top-3 right-3 px-3 py-1.5 rounded-full bg-cream/90 text-ink text-xs"
            >
              pause
            </button>
          )}
          {scanning && lastCaptured.length > 0 && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-wrap justify-center gap-1.5 max-w-[90%] animate-in fade-in slide-in-from-bottom-2">
              {lastCaptured.map((name) => (
                <span
                  key={name}
                  className="px-3 py-1.5 rounded-full bg-accent text-ink font-display text-lg leading-none shadow-lg"
                >
                  + {name}
                </span>
              ))}
            </div>
          )}
        </div>

        <section className="flex flex-col gap-3">
          <p className="text-xs uppercase tracking-[0.2em] text-ink-soft">
            Ingredients ({ingredients.length})
          </p>
          {ingredients.length === 0 ? (
            <p className="font-display text-xl text-ink-soft">
              {scanning
                ? "Looking… items appear after a couple of glances."
                : "Start scanning, or add one below."}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {ingredients.map((name) => (
                <li
                  key={name}
                  className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-full bg-blush text-ink animate-in fade-in slide-in-from-bottom-1"
                >
                  <span className="font-display text-lg leading-none">
                    {name}
                  </span>
                  <button
                    onClick={() => removeIngredient(name)}
                    className="w-5 h-5 grid place-items-center rounded-full hover:bg-blush-deep text-ink/70"
                    aria-label={`Remove ${name}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addIngredient();
            }}
            className="flex items-center gap-2 mt-1"
          >
            <input
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              placeholder="Add something…"
              className="flex-1 px-4 py-2.5 rounded-full bg-cream-dim text-sm placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:ring-ink/20"
            />
            <button
              type="submit"
              disabled={!adding.trim()}
              className="w-10 h-10 rounded-full bg-ink text-cream grid place-items-center disabled:opacity-30"
              aria-label="Add ingredient"
            >
              +
            </button>
          </form>
        </section>

        {error && (
          <div className="rounded-xl bg-blush text-ink px-4 py-3 text-sm">
            {error}
          </div>
        )}

        <div className="mt-auto flex flex-col gap-2">
          {!isPaid && (
            <p className="text-xs text-center text-ink-soft">
              {atLimit ? (
                <>
                  Daily free recipes used.{" "}
                  <button
                    onClick={() => setPaywallOpen(true)}
                    className="underline"
                  >
                    Unlock unlimited
                  </button>
                </>
              ) : (
                <>
                  {usageCount} of {FREE_DAILY_LIMIT} free recipes today
                </>
              )}
            </p>
          )}
          <button
            onClick={makeRecipe}
            disabled={ingredients.length === 0}
            className="rounded-2xl bg-ink text-cream py-4 font-display text-2xl disabled:opacity-30 flex items-center justify-center gap-2"
          >
            <span>📸</span>
            <span>Cook this up</span>
          </button>
        </div>

        {paywallOpen && (
          <Paywall onClose={() => setPaywallOpen(false)} />
        )}
      </main>
    );
  }

  if (phase === "loading") {
    return (
      <main className="mx-auto w-full max-w-md px-5 pt-6 pb-8 flex flex-col gap-6 min-h-dvh">
        <header className="flex items-center justify-between">
          <span className="w-9" />
          <p className="text-xs uppercase tracking-[0.2em] text-ink-soft">
            loading
          </p>
          <span className="w-9" />
        </header>

        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className="w-40 h-40 rounded-2xl bg-cream-dim grid place-items-center overflow-hidden">
            <span
              key={loadingEmoji}
              className="text-7xl animate-[foodpop_350ms_ease-out]"
              role="img"
              aria-label="cooking"
            >
              {loadingEmoji}
            </span>
          </div>
          <p className="font-display text-3xl text-center leading-tight">
            Cooking up
            <br />
            your recipe…
          </p>
          <div className="w-full max-w-xs h-1.5 rounded-full bg-cream-dim overflow-hidden">
            <div className="h-full bg-accent animate-[loadbar_2.4s_ease-in-out_infinite]" />
          </div>
        </div>

        <style>{`
          @keyframes loadbar {
            0% { width: 5%; }
            50% { width: 70%; }
            100% { width: 95%; }
          }
          @keyframes foodpop {
            0% { transform: scale(0.6) rotate(-12deg); opacity: 0; }
            60% { transform: scale(1.15) rotate(4deg); opacity: 1; }
            100% { transform: scale(1) rotate(0deg); opacity: 1; }
          }
        `}</style>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-md px-5 pt-6 pb-8 flex flex-col gap-5 min-h-dvh">
      <header className="flex items-center justify-between">
        <button
          onClick={reset}
          aria-label="Back"
          className="w-9 h-9 grid place-items-center text-ink-soft"
        >
          <BackIcon />
        </button>
        <span className="text-xs uppercase tracking-[0.2em] text-ink-soft">
          recipe
        </span>
        <button
          onClick={() => setSaved((s) => !s)}
          aria-label="Save"
          className="w-9 h-9 grid place-items-center"
        >
          <HeartIcon filled={saved} />
        </button>
      </header>

      {recipe && (
        <>
          <h1 className="font-display text-5xl leading-[0.95]">
            {recipe.title}
          </h1>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-soft">
            {recipe.minutes} min · serves {recipe.serves}
          </p>
          <p className="text-sm text-ink-soft -mt-2">{recipe.description}</p>

          <ul className="flex flex-wrap gap-2">
            {recipe.ingredients.map((ing) => (
              <li
                key={ing}
                className="px-3 py-1.5 rounded-full bg-blush font-display text-lg leading-none"
              >
                {ing}
              </li>
            ))}
          </ul>

          <section className="flex flex-col gap-3 mt-2">
            <p className="text-xs uppercase tracking-[0.2em] text-ink-soft">
              Steps
            </p>
            <ol className="flex flex-col gap-4">
              {recipe.steps.map((s, i) => (
                <li key={i} className="flex gap-3 items-start">
                  <span className="shrink-0 w-8 h-8 rounded-full bg-cream-dim grid place-items-center font-display text-lg">
                    {i + 1}
                  </span>
                  <span className="text-base leading-snug pt-0.5">{s}</span>
                </li>
              ))}
            </ol>
          </section>

          <div className="mt-auto flex flex-col gap-3 pt-6">
            <button
              onClick={makeRecipe}
              className="rounded-2xl bg-ink text-cream py-4 font-display text-2xl"
            >
              Try another
            </button>
            <button
              onClick={reset}
              className="text-sm text-ink-soft underline self-center"
            >
              Scan again
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function Paywall({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-ink/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-cream rounded-3xl p-6 flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-3xl leading-tight">
          You&apos;re cooking!
        </h2>
        <p className="text-sm text-ink-soft">
          You&apos;ve used your {FREE_DAILY_LIMIT} free recipes for today.
          Upgrade to Pro for unlimited recipes, saved favorites, and meal
          planning.
        </p>
        <ul className="flex flex-col gap-1.5 text-sm">
          <li>✨ Unlimited daily recipes</li>
          <li>💾 Save & organize favorites</li>
          <li>🛒 Smart grocery lists</li>
        </ul>
        <button
          onClick={() => {
            // TODO: wire to billing (Stripe / RevenueCat / app-store IAP)
            alert("Billing coming soon");
          }}
          className="rounded-2xl bg-ink text-cream py-3.5 font-display text-xl"
        >
          Upgrade to Pro
        </button>
        <button
          onClick={onClose}
          className="text-sm text-ink-soft underline self-center"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}

function CameraIcon() {
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill={filled ? "var(--color-accent)" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
