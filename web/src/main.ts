import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { bandColors, bandMinutes, paint } from "./colors";
import type { Meta } from "./graph";
import { latToMercY, lonToMercX, mercXToLon, mercYToLat } from "./mercator";
import type { Isochrone, Itinerary, RouteParams } from "./router";
import type { WorkerRequest, WorkerResponse } from "./router.worker";

const DEFAULT_START: [number, number] = [-122.4056, 37.7852]; // Powell St
// Fallback line colors by mode group when a route has no GTFS color.
const GROUP_COLORS = ["#2563eb", "#7c3aed", "#dc2626", "#0891b2"];
const SLIDERS = ["maxMinutes", "transferPenaltyMin", "initialWaitMin", "walkSpeedKmh"] as const;
type SliderKey = (typeof SLIDERS)[number];
const FORMAT: Record<SliderKey, (v: number) => string> = {
  maxMinutes: (v) => (v < 60 ? `${v} min` : `${Math.floor(v / 60)} h${v % 60 ? ` ${v % 60} min` : ""}`),
  transferPenaltyMin: (v) => `${v} min`,
  initialWaitMin: (v) => `${v} min`,
  walkSpeedKmh: (v) => `${v} km/h`,
};

const DEFAULT_PERIOD = "rush";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const tooltip = $("tooltip");

// --- URL state: ?from=lat,lon&to=lat,lon&when=period ------------------------

function parseLatLon(v: string | null): [number, number] | null {
  const m = v?.split(",").map(Number);
  if (!m || m.length !== 2 || !m.every(Number.isFinite)) return null;
  const [lat, lon] = m;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

const fmtLatLon = ([lon, lat]: [number, number]) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
const initialUrl = new URLSearchParams(location.search);

let meta: Meta | null = null;
let modes: boolean[] = [];
let start: [number, number] = parseLatLon(initialUrl.get("from")) ?? DEFAULT_START;
let iso: Isochrone | null = null;
let imageUrl: string | null = null;
let dest: [number, number] | null = parseLatLon(initialUrl.get("to"));
let periodId = initialUrl.get("when") ?? DEFAULT_PERIOD;
let pathReqId = 0;

function writeUrl() {
  const q = new URLSearchParams();
  q.set("from", fmtLatLon(start));
  if (dest) q.set("to", fmtLatLon(dest));
  if (periodId !== DEFAULT_PERIOD) q.set("when", periodId);
  // Commas are safe in query strings; keep them readable.
  history.replaceState(null, "", `${location.pathname}?${q.toString().replace(/%2C/g, ",")}`);
}

// --- worker, with request coalescing so slider drags don't queue up ---------

const worker = new Worker(new URL("./router.worker.ts", import.meta.url), { type: "module" });
let busy = false;
let dirty = false;
let reqId = 0;

function requestRoute() {
  if (!meta) return;
  if (busy) {
    dirty = true;
    return;
  }
  busy = true;
  dirty = false;
  const msg: WorkerRequest = { type: "route", id: ++reqId, params: currentParams() };
  worker.postMessage(msg);
}

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  if (msg.type === "error") {
    statusEl.textContent = msg.message;
    statusEl.classList.add("error");
  } else if (msg.type === "ready") {
    meta = msg.meta;
    buildModeToggles(meta);
    buildPeriodSelect(meta);
    statusEl.textContent = `Loaded ${msg.nodeCount.toLocaleString()} nodes, ${meta.agencies.length} agencies.`;
    requestRoute();
  } else if (msg.type === "result") {
    busy = false;
    if (dirty) requestRoute();
    else if (dest) requestPath();
    iso = msg.iso;
    render();
    const s = iso.stats;
    statusEl.textContent =
      `${s.stopsReached.toLocaleString()} stops reachable · ` +
      `routing ${s.dijkstraMs.toFixed(0)} ms, raster ${s.rasterMs.toFixed(0)} ms`;
  } else if (msg.type === "path") {
    if (msg.id === pathReqId) showItinerary(msg.itinerary);
  }
};

function requestPath() {
  if (!meta || !dest) return;
  // Minimum click target of ~16 screen pixels, so small reachable spots are easy to hit when zoomed out.
  const metersPerPixel = (40_075_016.686 * Math.cos((dest[1] * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
  const msg: WorkerRequest = {
    type: "path", id: ++pathReqId, lon: dest[0], lat: dest[1], clickRadiusM: 16 * metersPerPixel,
  };
  worker.postMessage(msg);
}

function currentParams(): RouteParams {
  const v = (k: SliderKey) => Number($<HTMLInputElement>(k).value);
  return {
    lon: start[0],
    lat: start[1],
    maxMinutes: v("maxMinutes"),
    walkSpeedKmh: v("walkSpeedKmh"),
    transferPenaltyMin: v("transferPenaltyMin"),
    initialWaitMin: v("initialWaitMin"),
    modes,
    period: meta ? meta.periods.findIndex((p) => p.id === periodId) : -1,
  };
}

function buildPeriodSelect(m: Meta) {
  const sel = $<HTMLSelectElement>("period");
  const options = [...m.periods, { id: "any", label: "Any time (fastest trip ever)" }];
  if (!options.some((o) => o.id === periodId)) periodId = DEFAULT_PERIOD;
  for (const o of options) sel.add(new Option(o.label, o.id, false, o.id === periodId));
  sel.addEventListener("change", () => {
    periodId = sel.value;
    writeUrl();
    requestRoute();
  });
}

// --- controls ---------------------------------------------------------------

for (const k of SLIDERS) {
  const input = $<HTMLInputElement>(k);
  const out = $(`${k}-out`);
  const sync = () => (out.textContent = FORMAT[k](Number(input.value)));
  sync();
  input.addEventListener("input", () => {
    sync();
    requestRoute();
  });
}

function buildModeToggles(m: Meta) {
  const present = new Set(m.routes.map((r) => r.group));
  modes = m.modeGroups.map(() => true);
  const fs = $("modes");
  m.modeGroups.forEach((name, i) => {
    if (!present.has(i)) return;
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("change", () => {
      modes[i] = cb.checked;
      requestRoute();
    });
    label.append(cb, ` ${name}`);
    fs.append(label);
  });
}

function renderLegend(maxMinutes: number, colors: [number, number, number][], band: number) {
  $("legend").innerHTML = colors
    .map((c, i) => {
      const lo = i * band;
      const hi = Math.min(maxMinutes, lo + band);
      return `<span><i style="background:rgb(${c.join(",")})"></i>${lo}–${hi}</span>`;
    })
    .join("");
}

// --- map --------------------------------------------------------------------

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: start,
  zoom: 11.5,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

// Positron is all greys; give water and parks a faint tint that still lets the
// isochrone read clearly on top.
const BASEMAP_TINTS: [layer: string, prop: "fill-color" | "line-color", color: string][] = [
  ["water", "fill-color", "#c6dcee"],
  ["waterway", "line-color", "#b3cfe6"],
  ["park", "fill-color", "#dcebd6"],
  ["landcover_wood", "fill-color", "#d3e5cd"],
];
map.on("style.load", () => {
  for (const [id, prop, color] of BASEMAP_TINTS) {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, color);
  }
  // City parks (leisure=park) are landcover "grass" in OpenMapTiles, which Positron doesn't draw.
  if (map.getSource("openmaptiles") && map.getLayer("waterway")) {
    map.addLayer({
      id: "landcover-grass-tint", type: "fill", source: "openmaptiles", "source-layer": "landcover",
      filter: ["==", ["get", "class"], "grass"],
      paint: { "fill-color": "#dcebd6" },
    }, "waterway");
  }
});

const marker = new maplibregl.Marker({ draggable: true, color: "#1f2937" }).setLngLat(start).addTo(map);
marker.on("dragend", () => {
  const ll = marker.getLngLat();
  start = [ll.lng, ll.lat];
  writeUrl();
  requestRoute();
});
const destMarker = new maplibregl.Marker({ color: "#2563eb" });
if (dest) destMarker.setLngLat(dest).addTo(map);
map.on("click", (e) => {
  dest = [e.lngLat.lng, e.lngLat.lat];
  destMarker.setLngLat(e.lngLat).addTo(map);
  writeUrl();
  requestPath();
});
writeUrl();

function setStart(lngLat: [number, number]) {
  start = lngLat;
  marker.setLngLat(lngLat);
  writeUrl();
  requestRoute();
}

function clearDestination() {
  dest = null;
  pathReqId++;
  destMarker.remove();
  $("itinerary").hidden = true;
  setRouteGeometry([]);
  writeUrl();
}

// --- route line + itinerary -------------------------------------------------

interface LineFeature {
  type: "Feature";
  properties: { kind: string; color: string };
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

let routeFeatures: LineFeature[] = [];

function setRouteGeometry(features: LineFeature[]) {
  routeFeatures = features;
  const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  src?.setData({ type: "FeatureCollection", features });
}

function addRouteLayers() {
  // A path restored from the URL can arrive before the map style loads.
  map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: routeFeatures } });
  const layout = { "line-join": "round", "line-cap": "round" } as const;
  map.addLayer({
    id: "route-casing", type: "line", source: "route", filter: ["==", ["get", "kind"], "ride"], layout,
    paint: { "line-color": "#ffffff", "line-width": 8 },
  });
  map.addLayer({
    id: "route-ride", type: "line", source: "route", filter: ["==", ["get", "kind"], "ride"], layout,
    paint: { "line-color": ["get", "color"], "line-width": 5 },
  });
  map.addLayer({
    id: "route-walk", type: "line", source: "route", filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-join": "round", "line-cap": "butt" },
    paint: { "line-color": "#374151", "line-width": 3, "line-dasharray": [1, 1.5] },
  });
}

function routeColor(routeIdx: number): string {
  const r = meta!.routes[routeIdx];
  return /^[0-9a-fA-F]{6}$/.test(r.color) ? `#${r.color}` : GROUP_COLORS[r.group] ?? GROUP_COLORS[0];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const mins = (sec: number) => `${Math.max(1, Math.round(sec / 60))} min`;

function showItinerary(it: Itinerary | null) {
  const el = $("itinerary");
  el.hidden = false;
  const actions =
    `<div class="it-actions"><button id="it-start">Set as start</button><button id="it-clear">Clear</button></div>`;
  if (!it) {
    el.innerHTML = `<div class="it-head">Not reachable within the time limit</div>${actions}`;
    setRouteGeometry([]);
  } else {
    const rows = it.legs.map((leg) => {
      if (leg.kind === "walk") {
        return `<li class="walk"><span class="dot"></span><div>Walk ${mins(leg.seconds)}` +
          `<small>${Math.round(leg.meters / 10) * 10} m</small></div></li>`;
      }
      const r = meta!.routes[leg.route];
      const name = esc(r.shortName || r.longName || r.agency);
      const penalty = leg.penaltySeconds >= 30 ? ` · +${mins(leg.penaltySeconds)} penalty` : "";
      return `<li class="ride"><span class="pill" style="background:${routeColor(leg.route)}">${name}</span>` +
        `<div>${esc(leg.fromStop)} → ${esc(leg.toStop)}` +
        `<small>${esc(r.agency)} · ${mins(leg.seconds)} · ${leg.stops} stop${leg.stops === 1 ? "" : "s"}${penalty}</small></div></li>`;
    });
    let note = "";
    if (it.snappedTo) {
      // Move the destination onto the reachable point we routed to.
      dest = [it.snappedTo.lon, it.snappedTo.lat];
      destMarker.setLngLat(dest);
      writeUrl();
      note = `<p class="it-note">Moved to the nearest reachable point, ${Math.round(it.snappedTo.meters / 10) * 10} m from where you clicked.</p>`;
    }
    el.innerHTML = `<div class="it-head">~${mins(it.totalSeconds)} to here</div>${note}<ol>${rows.join("")}</ol>${actions}`;
    setRouteGeometry(it.legs.map((leg) => ({
      type: "Feature",
      properties: { kind: leg.kind, color: leg.kind === "ride" ? routeColor(leg.route) : "#374151" },
      geometry: { type: "LineString", coordinates: leg.coords },
    })));
  }
  $("it-start").onclick = () => {
    const d = dest!;
    clearDestination();
    setStart(d);
  };
  $("it-clear").onclick = clearDestination;
}

// isStyleLoaded() can flip back to false while tiles load, which silently
// dropped results that arrived then; track the one-time load instead.
let mapReady = false;

function render() {
  if (!iso || !mapReady) return;
  const maxMinutes = iso.maxSeconds / 60;
  const band = bandMinutes(maxMinutes);
  const colors = bandColors(Math.ceil(maxMinutes / band));
  renderLegend(maxMinutes, colors, band);

  const canvas = document.createElement("canvas");
  canvas.width = iso.width;
  canvas.height = iso.height;
  canvas.getContext("2d")!.putImageData(paint(iso, band * 60, colors), 0, 0);

  const { x0, y0, cell, width, height } = iso;
  const west = mercXToLon(x0), east = mercXToLon(x0 + width * cell);
  const north = mercYToLat(y0), south = mercYToLat(y0 + height * cell);
  const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
    [west, north], [east, north], [east, south], [west, south],
  ];

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const src = map.getSource("iso") as maplibregl.ImageSource | undefined;
    if (src) {
      src.updateImage({ url, coordinates });
    } else {
      map.addSource("iso", { type: "image", url, coordinates });
      const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
      map.addLayer(
        { id: "iso", type: "raster", source: "iso", paint: { "raster-opacity": 0.55, "raster-fade-duration": 0 } },
        firstSymbol,
      );
    }
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = url;
  });
}

map.on("load", () => {
  mapReady = true;
  addRouteLayers();
  render();
});

map.on("mousemove", (e) => {
  if (!iso) return;
  const gx = Math.floor((lonToMercX(e.lngLat.lng) - iso.x0) / iso.cell);
  const gy = Math.floor((latToMercY(e.lngLat.lat) - iso.y0) / iso.cell);
  const t = gx >= 0 && gy >= 0 && gx < iso.width && gy < iso.height ? iso.times[gy * iso.width + gx] : Infinity;
  if (!(t <= iso.maxSeconds)) {
    tooltip.hidden = true;
    return;
  }
  tooltip.hidden = false;
  tooltip.textContent = `${Math.round(t / 60)} min`;
  tooltip.style.transform = `translate(${e.point.x + 14}px, ${e.point.y + 14}px)`;
});
map.on("mouseout", () => (tooltip.hidden = true));
