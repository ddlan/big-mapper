// Daily game UI: area circle, blind guessing, feedback, reveal and share.
// Routing is delegated to main.ts via hooks so the worker pipeline stays in one place.

import * as maplibregl from "maplibre-gl";

import {
  dailyParams, dayNumber, GUESSES_PER_DAY, type Guess, localDateKey, metersBetween, pctOfBest,
  type Puzzle, type PuzzleFile, tile, twistById, type Twist,
} from "./daily";
import type { Meta } from "./graph";
import type { RouteParams } from "./router";

export interface GameHooks {
  /** Route from a spot under today's params and display its isochrone; km² comes back via onRouted. */
  show(lon: number, lat: number): void;
  /** Hide the isochrone (blind until the first guess). */
  hideIsochrone(): void;
  /** Whether a spot is water on the basemap (guesses must be on land). */
  isWater(p: [number, number]): boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TILE_COLORS: Record<string, string> = { "🟩": "#16a34a", "🟨": "#eab308", "🟧": "#f97316", "🟥": "#dc2626" };

function circlePolygon(center: [number, number], radiusM: number): [number, number][] {
  const k = 111_195;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([
      center[0] + (radiusM * Math.cos(a)) / (k * Math.cos((center[1] * Math.PI) / 180)),
      center[1] + (radiusM * Math.sin(a)) / k,
    ]);
  }
  return pts;
}

export class DailyGame {
  private file: PuzzleFile | null = null;
  private loading: Promise<void> | null = null;
  private meta: Meta | null = null;
  private puzzle: Puzzle | null = null;
  private twist: Twist | null = null;
  private guesses: Guess[] = [];
  private pending: [number, number] | null = null;
  private pendingInWater = false;
  /** Guess awaiting its score from the router. */
  private scoring: [number, number] | null = null;
  private active = false;
  private markers: maplibregl.Marker[] = [];
  private pendingMarker: maplibregl.Marker;
  private bestMarker: maplibregl.Marker;
  private layersAdded = false;

  constructor(
    private map: maplibregl.Map,
    private hooks: GameHooks,
    private day = localDateKey(),
  ) {
    this.pendingMarker = new maplibregl.Marker({ color: "#6b7280", draggable: true });
    this.pendingMarker.on("dragend", () => {
      const ll = this.pendingMarker.getLngLat();
      this.setPending([ll.lng, ll.lat]);
    });
    const star = document.createElement("div");
    star.className = "best-marker";
    star.textContent = "★";
    this.bestMarker = new maplibregl.Marker({ element: star });
  }

  get dayKey() {
    return this.day;
  }

  /** Router params for a spot under today's twist, or null if the puzzle isn't loaded. */
  params(lon: number, lat: number): RouteParams | null {
    return this.twist && this.meta ? dailyParams(this.twist, lon, lat, this.meta) : null;
  }

  async enter(meta: Meta) {
    this.active = true;
    this.meta = meta;
    $("daily-card").hidden = false;
    this.loading ??= fetch(`${import.meta.env.BASE_URL}data/daily.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((f: PuzzleFile | null) => void (this.file = f))
      .catch(() => {});
    await this.loading;
    if (!this.active) return;

    this.puzzle = this.file?.puzzles.find((p) => p.date === this.day) ?? null;
    this.twist = this.puzzle ? twistById(this.puzzle.twist) ?? null : null;
    if (!this.puzzle || !this.twist) {
      $("daily-card").innerHTML =
        `<p class="note">No puzzle for ${this.day}. Generate puzzles with <code>npm run daily</code>.</p>`;
      this.hooks.hideIsochrone();
      return;
    }
    this.guesses = this.load();
    this.ensureLayers();
    this.drawArea();
    const ring = circlePolygon(this.puzzle.center, this.puzzle.radiusM * 1.3);
    const lons = ring.map((c) => c[0]), lats = ring.map((c) => c[1]);
    const narrow = window.innerWidth < 600;
    this.map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: narrow ? 30 : { top: 40, bottom: 40, left: 320, right: 40 }, duration: 0 },
    );
    this.render();
    this.redrawGuesses();
    const last = this.guesses.at(-1);
    if (last) this.hooks.show(last.lon, last.lat);
    else this.hooks.hideIsochrone();
  }

  leave() {
    this.active = false;
    $("daily-card").hidden = true;
    this.pending = null;
    this.pendingMarker.remove();
    this.bestMarker.remove();
    for (const m of this.markers) m.remove();
    this.markers = [];
    this.setLayerVisibility(false);
  }

  onMapLoad() {
    if (!this.active || !this.puzzle) return;
    this.ensureLayers();
    this.drawArea();
    this.redrawGuesses();
  }

  onMapClick(lngLat: [number, number]) {
    if (!this.puzzle || this.done) return;
    this.setPending(lngLat);
  }

  /** Called by main.ts with the reachable area of the last routed spot. */
  onRouted(lon: number, lat: number, km2: number) {
    if (!this.scoring || this.scoring[0] !== lon || this.scoring[1] !== lat) return;
    this.scoring = null;
    this.guesses.push({ lon, lat, km2 });
    this.save();
    this.pending = null;
    this.pendingMarker.remove();
    this.redrawGuesses();
    this.render();
  }

  private get done() {
    return this.guesses.length >= GUESSES_PER_DAY || this.guesses.some((g) => this.pct(g) >= 99.5);
  }

  private pct(g: Guess) {
    return pctOfBest(g.km2, this.puzzle!);
  }

  private validPending() {
    return !!this.pending && this.insideArea(this.pending) && !this.pendingInWater;
  }

  private insideArea(p: [number, number]) {
    return metersBetween(p, this.puzzle!.center) <= this.puzzle!.radiusM;
  }

  private setPending(p: [number, number]) {
    this.pending = p;
    this.pendingInWater = this.hooks.isWater(p);
    this.pendingMarker.setLngLat(p).addTo(this.map);
    this.render();
  }

  private submitGuess() {
    if (!this.pending || !this.validPending() || this.scoring || this.done) return;
    this.scoring = this.pending;
    this.render();
    this.hooks.show(this.pending[0], this.pending[1]);
  }

  // --- panel ----------------------------------------------------------------

  private render() {
    const p = this.puzzle!;
    const t = this.twist!;
    const el = $("daily-card");
    const dateLabel = new Date(`${p.date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const rows = Array.from({ length: GUESSES_PER_DAY }, (_, i) => {
      const g = this.guesses[i];
      if (!g) return `<li class="guess empty"><span class="tile"></span><span>Guess ${i + 1}</span></li>`;
      const pct = this.pct(g);
      return `<li class="guess" data-i="${i}"><span class="tile" style="background:${TILE_COLORS[tile(pct)]}">${i + 1}</span>` +
        `<span><b>${pct.toFixed(0)}%</b> of today's best</span><small>${g.km2.toFixed(0)} km²</small></li>`;
    }).join("");

    let action = "";
    if (this.done) {
      const best = Math.max(...this.guesses.map((g) => this.pct(g)));
      action = `<div class="daily-result"><div class="daily-final">${best.toFixed(0)}%</div>` +
        `<div class="note">Best spot: ${p.best.km2.toFixed(0)} km² (★ on the map). New puzzle tomorrow.</div>` +
        `<button id="daily-share" class="primary">Share result</button><div id="daily-share-msg" class="note"></div></div>`;
    } else if (this.scoring) {
      action = `<button class="primary" disabled>Scoring…</button>`;
    } else {
      const ok = this.validPending();
      const hint = !this.pending ? "Click inside the circle to place a pin."
        : !this.insideArea(this.pending) ? "That's outside the circle."
        : this.pendingInWater ? "That's in the water. Pick a spot on land."
        : "Drag the pin to adjust, then lock it in.";
      action = `<button id="daily-guess" class="primary" ${ok ? "" : "disabled"}>Lock in guess ${this.guesses.length + 1}</button>` +
        `<div class="note">${hint}</div>`;
    }

    const stale = this.file && this.meta && this.file.graphGenerated !== this.meta.generated
      ? `<p class="note warn">Puzzles were generated from an older data build; rerun npm run daily.</p>` : "";
    el.innerHTML = `
      <div class="daily-head">Daily #${dayNumber(p.date)} · ${dateLabel}</div>
      <div class="twist"><span class="twist-emoji">${t.emoji}</span><div><b>${t.label}</b><small>${t.description}</small></div></div>
      <p class="daily-goal">Find the best-connected spot within 1 km of <b>${p.name}</b>. You have ${GUESSES_PER_DAY} guesses; the map stays hidden until you commit.</p>
      <ol class="guesses">${rows}</ol>
      ${action}${stale}`;

    $("daily-guess")?.addEventListener("click", () => this.submitGuess());
    $("daily-share")?.addEventListener("click", () => this.share());
    for (const li of el.querySelectorAll<HTMLElement>("li.guess[data-i]")) {
      li.addEventListener("click", () => {
        const g = this.guesses[Number(li.dataset.i)];
        this.hooks.show(g.lon, g.lat);
      });
    }
  }

  private async share() {
    const p = this.puzzle!;
    const t = this.twist!;
    const best = Math.max(...this.guesses.map((g) => this.pct(g)));
    const text = `Big Mapper #${dayNumber(p.date)} ${t.emoji} ${t.label}\n` +
      `${this.guesses.map((g) => tile(this.pct(g))).join("")} ${best.toFixed(0)}%\n${location.origin}${location.pathname}?mode=daily`;
    const msg = $("daily-share-msg");
    try {
      await navigator.clipboard.writeText(text);
      msg.textContent = "Copied to clipboard!";
    } catch {
      msg.textContent = text;
    }
  }

  // --- map layers -------------------------------------------------------------

  private ensureLayers() {
    // main.ts adds its "route" source in the map load handler; wait for that.
    if (this.layersAdded || !this.map.getSource("route")) return;
    this.map.addSource("daily-area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    this.map.addSource("daily-grid", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    this.map.addLayer({
      id: "daily-area-fill", type: "fill", source: "daily-area",
      paint: { "fill-color": "#2563eb", "fill-opacity": 0.04 },
    });
    this.map.addLayer({
      id: "daily-area-line", type: "line", source: "daily-area",
      paint: { "line-color": "#2563eb", "line-width": 2, "line-dasharray": [2, 1.5] },
    });
    this.map.addLayer({
      id: "daily-grid", type: "circle", source: "daily-grid",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3, 15, 10],
        "circle-color": ["interpolate", ["linear"], ["get", "pct"], 40, "#dc2626", 70, "#f97316", 85, "#eab308", 100, "#16a34a"],
        "circle-opacity": 0.75,
        "circle-stroke-width": 0.5,
        "circle-stroke-color": "#ffffff",
      },
    });
    this.layersAdded = true;
  }

  private setLayerVisibility(visible: boolean) {
    if (!this.layersAdded) return;
    for (const id of ["daily-area-fill", "daily-area-line", "daily-grid"]) {
      this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }

  private drawArea() {
    if (!this.layersAdded || !this.puzzle) return;
    this.setLayerVisibility(true);
    const src = this.map.getSource("daily-area") as maplibregl.GeoJSONSource;
    src.setData({
      type: "Feature", properties: {},
      geometry: { type: "Polygon", coordinates: [circlePolygon(this.puzzle.center, this.puzzle.radiusM)] },
    });
  }

  private redrawGuesses() {
    for (const m of this.markers) m.remove();
    this.markers = this.guesses.map((g, i) => {
      const el = document.createElement("div");
      el.className = "guess-marker";
      el.style.background = TILE_COLORS[tile(this.pct(g))];
      el.textContent = String(i + 1);
      return new maplibregl.Marker({ element: el }).setLngLat([g.lon, g.lat]).addTo(this.map);
    });

    // Reveal the answer and the area's heatmap once the game is over.
    const p = this.puzzle!;
    const grid = this.map.getSource("daily-grid") as maplibregl.GeoJSONSource | undefined;
    if (this.done) {
      this.bestMarker.setLngLat([p.best.lon, p.best.lat]).addTo(this.map);
      grid?.setData({
        type: "FeatureCollection",
        features: p.grid.map(([lon, lat, km2]) => ({
          type: "Feature", properties: { pct: pctOfBest(km2, p) },
          geometry: { type: "Point", coordinates: [lon, lat] },
        })),
      });
    } else {
      this.bestMarker.remove();
      grid?.setData({ type: "FeatureCollection", features: [] });
    }
  }

  // --- persistence (per-browser convenience; the game works without it) -------

  private storageKey() {
    // Include the area so regenerated puzzles don't inherit old guesses.
    return `bigmapper:daily:${this.day}:${this.puzzle?.name ?? ""}`;
  }

  private load(): Guess[] {
    try {
      const v = JSON.parse(localStorage.getItem(this.storageKey()) ?? "[]");
      return Array.isArray(v) ? v.slice(0, GUESSES_PER_DAY) : [];
    } catch {
      return [];
    }
  }

  private save() {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(this.guesses));
    } catch {
      /* private mode etc. */
    }
  }
}
