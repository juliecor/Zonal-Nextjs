"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

const MapPanel = dynamic(() => import("./_MapPanel"), { ssr: false });

type LatLngTuple = [number, number];
type PickSource = "click" | "drag" | "dragend";

type Row = {
  region: string;
  province: string;
  municipality: string;
  barangay: string;
  street: string;
  vicinity: string;
  classification: string;
  zonalValue: number;
};

type Geo = {
  displayName: string;
  lat: number;
  lng: number;
  address?: any;
};

type NominatimSuggestion = {
  display_name: string;
  lat: string;
  lon: string;
  address?: any;
};

type Reports = {
  hospitals: number;
  schools: number;
  police: number;
  fire: number;
  pharmacy: number;
  bank: number;
  market: number;
  mall: number;
  transport: number;
};

type Manifest = Record<string, string>;

/* ---------------- utils ---------------- */

function clsx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function norm(s: string) {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(v: string): number {
  const cleaned = (v ?? "")
    .toString()
    .replace(/"/g, "")
    .replace(/,/g, "")
    .trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function money(n: number) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * RFC4180-ish CSV parser (handles quoted fields, commas, escaped quotes "")
 * Also supports TSV automatically if first line contains tabs.
 */
function parseDelimited(text: string): string[][] {
  const raw = text.replace(/\r/g, "");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

  const delimiter = lines[0].includes("\t") ? "\t" : ",";

  const rows: string[][] = [];
  for (const line of lines) {
    if (delimiter === "\t") {
      rows.push(line.split("\t").map((s) => s.trim()));
      continue;
    }

    const out: string[] = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }

      if (ch === "," && !inQuotes) {
        out.push(cur.trim());
        cur = "";
        continue;
      }

      cur += ch;
    }

    out.push(cur.trim());
    rows.push(out);
  }

  return rows;
}

/** Supports CSV or TSV, with or without header row */
function parseZonalFile(text: string): Row[] {
  const grid = parseDelimited(text);
  if (!grid.length) return [];

  const first = (grid[0] ?? []).map((s) => (s ?? "").toLowerCase());
  const hasHeader =
    first.includes("province") ||
    first.includes("municipality") ||
    first.includes("barangay") ||
    first.includes("zonal_value") ||
    first.includes("revenue region no.");

  const data = hasHeader ? grid.slice(1) : grid;

  return data.map((c) => {
    const [
      region = "",
      province = "",
      municipality = "",
      barangay = "",
      street = "",
      vicinity = "",
      classification = "",
      zonalRaw = "",
    ] = c;

    return {
      region,
      province,
      municipality,
      barangay,
      street,
      vicinity,
      classification,
      zonalValue: parseMoney(String(zonalRaw)),
    };
  });
}

/* ---------------- dataset key detection ---------------- */

function normalizeKey(s?: string | null) {
  if (!s) return "";
  return String(s)
    .trim()
    .replace(/\bprovince\b/gi, "")
    .replace(/\bprovincia\b/gi, "")
    .replace(/[\s._-]+/g, "")
    .toUpperCase();
}

const CITY_OVERRIDES: Record<string, string> = {
  BAGUIO: "BAGUIOCITY",
  TARLACCITY: "TARLACCITY",
 
};

function detectCityName(address: any): string {
  if (!address) return "";
  return (
    address.city ||
    address.town ||
    address.municipality ||
    address.city_district ||
    address.suburb ||
    ""
  );
}

function detectProvinceName(address: any): string {
  if (!address) return "";
  return (
    address.province ||
    address.state ||
    address.county ||
    address.region ||
    ""
  );
}

function detectDatasetKey(address: any) {
  const cityKey = normalizeKey(detectCityName(address));
  if (CITY_OVERRIDES[cityKey]) return CITY_OVERRIDES[cityKey];

  const provKey = normalizeKey(detectProvinceName(address));
  return provKey;
}

/* ---------------- nominatim ---------------- */

async function nominatimSearch(
  q: string,
  limit = 5,
  signal?: AbortSignal
): Promise<NominatimSuggestion[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${limit}&q=${encodeURIComponent(
    q
  )}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error("Autocomplete failed");
  return (await res.json()) as NominatimSuggestion[];
}

async function nominatimGeocodeTop(q: string, signal?: AbortSignal): Promise<Geo> {
  const results = await nominatimSearch(q, 1, signal);
  if (!results.length) throw new Error("No location found");
  const top = results[0];
  return {
    displayName: top.display_name,
    lat: Number(top.lat),
    lng: Number(top.lon),
    address: top.address ?? {},
  };
}

async function nominatimReverse(lat: number, lng: number, signal?: AbortSignal): Promise<Geo> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${encodeURIComponent(
    String(lat)
  )}&lon=${encodeURIComponent(String(lng))}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new Error("Reverse geocoding failed");
  const j = (await res.json()) as any;
  return {
    displayName: j.display_name ?? `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    lat: Number(j.lat ?? lat),
    lng: Number(j.lon ?? lng),
    address: j.address ?? {},
  };
}

/* ---------------- manifest + dataset loader ---------------- */

async function fetchManifest(signal?: AbortSignal): Promise<Manifest> {
  const res = await fetch("/zonal/manifest.json", { cache: "no-store", signal });
  if (!res.ok) throw new Error("Failed to load /zonal/manifest.json");
  return (await res.json()) as Manifest;
}

const datasetCache = new Map<string, Row[]>();

async function loadRows(manifest: Manifest, key: string, signal?: AbortSignal): Promise<Row[]> {
  if (datasetCache.has(key)) return datasetCache.get(key)!;

  const path = manifest[key];
  if (!path) throw new Error(`No CSV mapped for key: ${key}`);

  const res = await fetch(path, { cache: "force-cache", signal });
  if (!res.ok) throw new Error(`Failed to load CSV: ${path}`);

  const text = await res.text();
  const rows = parseZonalFile(text);
  if (!rows.length) throw new Error(`Loaded ${path} but got 0 rows`);

  datasetCache.set(key, rows);
  return rows;
}

/* ---------------- overpass ---------------- */

const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

function looksRateLimited(msg: string) {
  const m = msg.toLowerCase();
  return m.includes("rate_limited") || m.includes("too many") || m.includes("429") || m.includes("quota");
}

function looksOverpassTimeout(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes("504") ||
    m.includes("gateway timeout") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("execution time") ||
    m.includes("502") ||
    m.includes("503")
  );
}

type OverpassWay = {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  center?: { lat: number; lon: number };
};

type OverpassNode = {
  type: "node";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
};

type OverpassElement = OverpassWay | OverpassNode | any;

async function postOverpass(endpoint: string, query: string, signal?: AbortSignal): Promise<{ elements?: OverpassElement[] }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Overpass error (${res.status}): ${text.slice(0, 220)}`);

  try {
    return JSON.parse(text) as { elements?: OverpassElement[] };
  } catch {
    throw new Error(`Overpass returned non-JSON: ${text.slice(0, 220)}`);
  }
}

async function overpassWithFallback(query: string, signal?: AbortSignal) {
  let lastErr: any = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      return await postOverpass(ep, query, signal);
    } catch (e: any) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr ?? new Error("Overpass failed");
}

/* ---------------- reports ---------------- */

function dedupeElements(els: Array<{ type: string; id: number }>) {
  const seen = new Set<string>();
  const out: typeof els = [];
  for (const e of els) {
    const key = `${e.type}:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

const reportsCache = new Map<string, Reports>();

async function fetchReports(lat: number, lng: number, radius: number, signal?: AbortSignal): Promise<Reports> {
  const key = `${lat.toFixed(5)}:${lng.toFixed(5)}:${radius}`;
  const cached = reportsCache.get(key);
  if (cached) return cached;

  const amenityQuery = `
[out:json][timeout:25];
nwr["amenity"~"^(hospital|school|police|fire_station|pharmacy|bank|marketplace)$"](around:${radius},${lat},${lng});
out tags;
`;

  const mallQuery = `
[out:json][timeout:25];
nwr["shop"="mall"](around:${radius},${lat},${lng});
out tags;
`;

  const transportQuery = `
[out:json][timeout:25];
(
  nwr["amenity"="bus_station"](around:${radius},${lat},${lng});
  nwr["railway"="station"](around:${radius},${lat},${lng});
  nwr["public_transport"="station"](around:${radius},${lat},${lng});
);
out tags;
`;

  const [amenityJson, mallJson, transportJson] = await Promise.all([
    overpassWithFallback(amenityQuery, signal),
    overpassWithFallback(mallQuery, signal),
    overpassWithFallback(transportQuery, signal),
  ]);

  const counts: Record<string, number> = {
    hospital: 0,
    school: 0,
    police: 0,
    fire_station: 0,
    pharmacy: 0,
    bank: 0,
    marketplace: 0,
  };

  for (const el of amenityJson.elements ?? []) {
    const a = el.tags?.amenity;
    if (a && counts[a] !== undefined) counts[a]++;
  }

  const mall = (mallJson.elements ?? []).length;
  const transport = dedupeElements((transportJson.elements ?? []).map((e) => ({ type: e.type, id: e.id }))).length;

  const final: Reports = {
    hospitals: counts.hospital,
    schools: counts.school,
    police: counts.police,
    fire: counts.fire_station,
    pharmacy: counts.pharmacy,
    bank: counts.bank,
    market: counts.marketplace,
    mall,
    transport,
  };

  reportsCache.set(key, final);
  return final;
}

/* ---------------- record -> point ---------------- */

function escapeOverpassRegex(s: string) {
  return (s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanRoadName(s: string) {
  return (s ?? "")
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRoadCandidates(vicinity: string) {
  const v = (vicinity ?? "").replace(/[’']/g, "'");
  const roads: string[] = [];

  const first = v.split(" - ")[0];
  if (first) roads.push(first);

  const junctionMatches = [...v.matchAll(/junction\s+([^,]+?)(?:\s+to|\s+-|,|$)/gi)];
  for (const m of junctionMatches) {
    const candidate = m[1]?.trim();
    if (candidate) roads.push(candidate);
  }

  return Array.from(new Set(roads.map(cleanRoadName).filter((x) => x.length >= 4))).slice(0, 3);
}

type JunctionClip = { main: string; a: string; b: string };

/**
 * Parse patterns like:
 *   "Upper Bonifacio St. - Junction Magsaysay Ave. to Junction Gen Luna Rd"
 *   "Upper Bonifacio St. - Junction Magsaysay Ave. to Dr Cuesta's Property"
 *
 * We REQUIRE A and B to look like real roads (not "property").
 */
function parseJunctionClip(vicinity: string): JunctionClip | null {
  const v = cleanRoadName(vicinity);
  if (!v.includes(" - ")) return null;

  const [mainRaw, restRaw] = v.split(" - ").map((s) => s.trim());
  const main = cleanRoadName(mainRaw);
  if (!main || main.length < 4) return null;

  // Try to extract "Junction <A> to Junction <B>" OR "Junction <A> to <B>"
  const m1 = restRaw.match(/junction\s+(.+?)\s+to\s+junction\s+(.+)$/i);
  const m2 = restRaw.match(/junction\s+(.+?)\s+to\s+(.+)$/i);

  let a = "";
  let b = "";
  if (m1) {
    a = cleanRoadName(m1[1]);
    b = cleanRoadName(m1[2]);
  } else if (m2) {
    a = cleanRoadName(m2[1]);
    b = cleanRoadName(m2[2]);
  } else {
    return null;
  }

  const bad = (s: string) => /property|cuesta'?s property|lot|house|compound/i.test(s);
  if (!a || !b || bad(a) || bad(b)) return null;

  return { main, a, b };
}

type CityAnchor = { lat: number; lng: number; label: string };
const cityAnchorCache = new Map<string, CityAnchor>();

async function getCityAnchor(municipality: string, province: string, signal?: AbortSignal): Promise<CityAnchor> {
  const key = `${norm(municipality)}|${norm(province)}`;
  const cached = cityAnchorCache.get(key);
  if (cached) return cached;

  const q = [municipality, province, "Philippines"].filter(Boolean).join(", ");
  const g = await nominatimGeocodeTop(q, signal);
  const anchor = { lat: g.lat, lng: g.lng, label: g.displayName };
  cityAnchorCache.set(key, anchor);
  return anchor;
}

async function overpassRoadMidpointAround(anchor: CityAnchor, roadA: string, signal?: AbortSignal) {
  const a = escapeOverpassRegex(roadA);
  const q = `
[out:json][timeout:20];
way(around:25000,${anchor.lat},${anchor.lng})["highway"]["name"~"${a}",i];
out center 1;
`;
  const json = await overpassWithFallback(q, signal);
  const w = (json.elements ?? []).find((e) => e.type === "way" && e.center);
  if (!w?.center) return null;
  return { lat: w.center.lat, lng: w.center.lon };
}

type RecordPoint = { lat: number; lng: number; label: string };
const recordPointCache = new Map<string, RecordPoint>();

function recordKey(r: Row) {
  return [r.province, r.municipality, r.barangay, r.vicinity, r.classification]
    .map((x) => norm(x))
    .join("|");
}

async function recordToPoint(r: Row, signal?: AbortSignal): Promise<RecordPoint> {
  const key = recordKey(r);
  const cached = recordPointCache.get(key);
  if (cached) return cached;

  const roads = extractRoadCandidates(r.vicinity);
  const anchor = await getCityAnchor(r.municipality, r.province, signal);

  // Try midpoint of first road candidate via Overpass
  if (roads.length >= 1) {
    try {
      const mid = await overpassRoadMidpointAround(anchor, roads[0], signal);
      if (mid) {
        const pt = { lat: mid.lat, lng: mid.lng, label: `${roads[0]}, ${r.municipality}` };
        recordPointCache.set(key, pt);
        return pt;
      }
    } catch {
      // continue
    }
  }

  // Nominatim fallback
  const query = [r.vicinity, r.barangay, r.municipality, r.province, "Philippines"].filter(Boolean).join(", ");
  const res = await nominatimSearch(query, 1, signal);

  if (!res.length) {
    const pt = { lat: anchor.lat, lng: anchor.lng, label: anchor.label };
    recordPointCache.set(key, pt);
    return pt;
  }

  const top = res[0];
  const pt = { lat: Number(top.lat), lng: Number(top.lon), label: top.display_name };
  recordPointCache.set(key, pt);
  return pt;
}

/* ---------------- polyline highlight: CLIPPED BETWEEN JUNCTIONS ---------------- */

type HighlightLine = {
  paths: LatLngTuple[][];
  label: string;
};

const roadGeomCache = new Map<string, LatLngTuple[]>(); // cache by key

function roadCacheKeyClip(municipality: string, province: string, main: string, a: string, b: string) {
  return `${norm(municipality)}|${norm(province)}|clip|${norm(main)}|${norm(a)}|${norm(b)}`;
}

function roadCacheKeyFull(municipality: string, province: string, road: string) {
  return `${norm(municipality)}|${norm(province)}|full|${norm(road)}`;
}

/** haversine in meters */
function haversineMeters(a: LatLngTuple, b: LatLngTuple) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;

  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);

  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function closestIndexOnLine(line: LatLngTuple[], pt: LatLngTuple) {
  let bestI = -1;
  let bestD = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = haversineMeters(line[i], pt);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return { idx: bestI, dist: bestD };
}

/** RDP simplification in meters */
function simplifyRDP(points: LatLngTuple[], epsilonMeters: number) {
  if (points.length <= 2) return points;

  const meanLat = points.reduce((s, p) => s + p[0], 0) / points.length;
  const latFactor = 111320;
  const lonFactor = 111320 * Math.cos((meanLat * Math.PI) / 180);

  const toXY = (p: LatLngTuple) => ({ x: p[1] * lonFactor, y: p[0] * latFactor });

  const perpendicularDistance = (p: LatLngTuple, a: LatLngTuple, b: LatLngTuple) => {
    const P = toXY(p);
    const A = toXY(a);
    const B = toXY(b);

    const dx = B.x - A.x;
    const dy = B.y - A.y;
    if (dx === 0 && dy === 0) {
      const ddx = P.x - A.x;
      const ddy = P.y - A.y;
      return Math.sqrt(ddx * ddx + ddy * ddy);
    }

    const t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / (dx * dx + dy * dy);
    const tt = Math.max(0, Math.min(1, t));
    const projX = A.x + tt * dx;
    const projY = A.y + tt * dy;

    const ddx = P.x - projX;
    const ddy = P.y - projY;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  };

  const rdp = (pts: LatLngTuple[], eps: number): LatLngTuple[] => {
    const first = pts[0];
    const last = pts[pts.length - 1];

    let index = -1;
    let distMax = 0;

    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpendicularDistance(pts[i], first, last);
      if (d > distMax) {
        distMax = d;
        index = i;
      }
    }

    if (distMax > eps && index !== -1) {
      const left = rdp(pts.slice(0, index + 1), eps);
      const right = rdp(pts.slice(index), eps);
      return left.slice(0, -1).concat(right);
    }

    return [first, last];
  };

  return rdp(points, epsilonMeters);
}

async function fetchClippedMainRoadBetweenJunctions(
  anchor: CityAnchor,
  main: string,
  a: string,
  b: string,
  refPoint: LatLngTuple,
  signal?: AbortSignal
): Promise<LatLngTuple[] | null> {
  const MAIN = escapeOverpassRegex(main);
  const A = escapeOverpassRegex(a);
  const B = escapeOverpassRegex(b);

  // One query: load main ways (geom) + intersection nodes between main & A, main & B
  const q = `
[out:json][timeout:25];
way(around:25000,${anchor.lat},${anchor.lng})["highway"]["name"~"${MAIN}",i]->.m;
way(around:25000,${anchor.lat},${anchor.lng})["highway"]["name"~"${A}",i]->.a;
way(around:25000,${anchor.lat},${anchor.lng})["highway"]["name"~"${B}",i]->.b;
node(w.m)(w.a)->.na;
node(w.m)(w.b)->.nb;
(.m; .na; .nb;);
out geom;
`;

  const json = await overpassWithFallback(q, signal);
  const els = json.elements ?? [];

  const mainWays = els.filter((e) => e.type === "way" && Array.isArray(e.geometry)) as OverpassWay[];
  const naNodes = els.filter((e) => e.type === "node" && typeof e.lat === "number" && typeof e.lon === "number") as OverpassNode[];

  if (!mainWays.length) return null;

  // Separate nodes into two sets na/nb is not preserved in output,
  // so we re-run indices by proximity: pick two best junction nodes by checking closeness to both A and B intersections is not possible.
  // Practical hack:
  // - we use ALL returned nodes as candidates
  // - for each main way, choose two nodes that map to distinct indices and minimize total distance to line.
  const nodes = naNodes.map((n) => [n.lat as number, n.lon as number] as LatLngTuple);
  if (nodes.length < 2) return null;

  // Choose best main way:
  let best: { line: LatLngTuple[]; score: number; i1: number; i2: number } | null = null;

  for (const w of mainWays) {
    const line = (w.geometry ?? []).map((g) => [g.lat, g.lon] as LatLngTuple);
    if (line.length < 2) continue;

    // Must be near record ref point
    const nearRef = closestIndexOnLine(line, refPoint);
    const refScore = nearRef.dist;

    // Find best pair of node indices on this line
    let bestPair: { score: number; i1: number; i2: number } | null = null;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const n1 = nodes[i];
        const n2 = nodes[j];

        const p1 = closestIndexOnLine(line, n1);
        const p2 = closestIndexOnLine(line, n2);

        // discard if too far from the line (means node isn't on this way)
        if (p1.dist > 60 || p2.dist > 60) continue;

        // discard if essentially same spot
        if (Math.abs(p1.idx - p2.idx) < 5) continue;

        // score: closer junction nodes + closer to ref area
        const s = p1.dist + p2.dist + refScore * 0.5;
        if (!bestPair || s < bestPair.score) bestPair = { score: s, i1: p1.idx, i2: p2.idx };
      }
    }

    if (!bestPair) continue;

    const totalScore = bestPair.score;
    if (!best || totalScore < best.score) {
      best = { line, score: totalScore, i1: bestPair.i1, i2: bestPair.i2 };
    }
  }

  if (!best) return null;

  const iMin = Math.min(best.i1, best.i2);
  const iMax = Math.max(best.i1, best.i2);

  let seg = best.line.slice(iMin, iMax + 1);
  if (seg.length < 2) return null;

  // simplify + clamp
  seg = simplifyRDP(seg, 12);
  if (seg.length > 500) {
    const step = Math.ceil(seg.length / 500);
    seg = seg.filter((_, idx) => idx % step === 0);
  }

  return seg;
}

async function fetchFullRoadGeometryAround(
  anchor: CityAnchor,
  road: string,
  refPoint: LatLngTuple,
  signal?: AbortSignal
): Promise<LatLngTuple[] | null> {
  const a = escapeOverpassRegex(road);
  const q = `
[out:json][timeout:25];
way(around:25000,${anchor.lat},${anchor.lng})["highway"]["name"~"${a}",i"];
out geom;
`;

  const json = await overpassWithFallback(q, signal);
  const ways = (json.elements ?? []).filter((e) => e.type === "way" && Array.isArray(e.geometry)) as OverpassWay[];
  if (!ways.length) return null;

  // Pick closest way to refPoint
  let best: { line: LatLngTuple[]; score: number } | null = null;
  for (const w of ways) {
    const line = (w.geometry ?? []).map((g) => [g.lat, g.lon] as LatLngTuple);
    if (line.length < 2) continue;

    const s = closestIndexOnLine(line, refPoint).dist;
    if (!best || s < best.score) best = { line, score: s };
  }

  if (!best) return null;

  let line = simplifyRDP(best.line, 15);
  if (line.length > 500) {
    const step = Math.ceil(line.length / 500);
    line = line.filter((_, idx) => idx % step === 0);
  }
  return line;
}

async function loadVicinityHighlight(
  row: Row,
  signal?: AbortSignal
): Promise<{ highlight: HighlightLine | null; warning?: string }> {
  const anchor = await getCityAnchor(row.municipality, row.province, signal);

  const refPt = await recordToPoint(row, signal).catch(() => ({
    lat: anchor.lat,
    lng: anchor.lng,
    label: anchor.label,
  }));
  const refTuple: LatLngTuple = [refPt.lat, refPt.lng];

  // 1) Try CLIPPED between junctions
  const clip = parseJunctionClip(row.vicinity);
  if (clip) {
    const ck = roadCacheKeyClip(row.municipality, row.province, clip.main, clip.a, clip.b);
    const cached = roadGeomCache.get(ck);
    if (cached) {
      return {
        highlight: { paths: [cached], label: `${row.vicinity} • ₱ ${money(row.zonalValue)}` },
      };
    }

    try {
      const seg = await fetchClippedMainRoadBetweenJunctions(anchor, clip.main, clip.a, clip.b, refTuple, signal);
      if (seg && seg.length >= 2) {
        roadGeomCache.set(ck, seg);
        return {
          highlight: { paths: [seg], label: `${row.vicinity} • ₱ ${money(row.zonalValue)}` },
        };
      }

      // fallback message continues to full road
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (looksRateLimited(msg) || looksOverpassTimeout(msg)) {
        return { highlight: null, warning: "Overpass is busy (timeout/rate-limit). Try again later." };
      }
      // keep going to fallback
    }
  }

  // 2) Fallback: full road highlight
  const roads = extractRoadCandidates(row.vicinity);
  if (!roads.length) return { highlight: null, warning: "No road names detected from this vicinity text." };

  const paths: LatLngTuple[][] = [];
  let warning: string | undefined;

  for (let i = 0; i < Math.min(2, roads.length); i++) {
    const road = roads[i];
    const ck = roadCacheKeyFull(row.municipality, row.province, road);
    const cached = roadGeomCache.get(ck);
    if (cached) {
      paths.push(cached);
      continue;
    }

    try {
      const geom = await fetchFullRoadGeometryAround(anchor, road, refTuple, signal);
      if (!geom || geom.length < 2) {
        warning = `Could not find geometry for "${road}" in OSM (or server returned empty).`;
        continue;
      }
      roadGeomCache.set(ck, geom);
      paths.push(geom);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (looksRateLimited(msg) || looksOverpassTimeout(msg)) {
        warning = "Overpass is busy (timeout/rate-limit). Try again later.";
        continue;
      }
      warning = msg || "Failed to load road geometry.";
    }
  }

  if (!paths.length) return { highlight: null, warning: warning ?? "No highlight geometry found." };

  return {
    highlight: { paths, label: `${row.vicinity} • ₱ ${money(row.zonalValue)}` },
    warning,
  };
}

/* ---------------- matching ---------------- */

function tokenSet(s: string) {
  return new Set(norm(s).split(" ").filter((t) => t.length >= 3));
}

function scoreRow(row: Row, queryText: string) {
  const q = norm(queryText);
  if (!q) return 0;
  const qTokens = tokenSet(q);

  const field = (label: string, weight: number) => {
    const f = norm(label);
    if (!f) return 0;

    let score = 0;
    if (f === q) score += 120 * weight;
    if (f.includes(q)) score += 55 * weight;

    const fTokens = tokenSet(f);
    let intersect = 0;
    for (const t of qTokens) if (fTokens.has(t)) intersect++;
    score += intersect * 6 * weight;
    return score;
  };

  let s =
    field(row.vicinity, 6) +
    field(row.street, 4) +
    field(row.barangay, 3) +
    field(row.municipality, 2) +
    field(row.province, 2) +
    field(row.classification, 1);

  if (!Number.isFinite(row.zonalValue)) s -= 250;
  return s;
}

/* ---------------- UI bits ---------------- */

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold text-slate-900">{title}</div>
      <div className="mt-3 text-sm text-slate-700">{children}</div>
    </div>
  );
}

function Metric({ label, value }: { label: number | string; value: number | string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

/* ---------------- report modal (same as before, shortened) ---------------- */

function tier(z: number) {
  if (!Number.isFinite(z) || z <= 0) return "Unknown";
  if (z >= 20000) return "Premium";
  if (z >= 10000) return "Upper-mid";
  if (z >= 5000) return "Mid";
  return "Entry";
}

function makeReport(args: {
  placeName: string;
  lat: number;
  lng: number;
  match: Row | null;
  reports: Reports | null;
  confidence: "High" | "Medium" | "Low" | "—";
  radius: number;
  datasetKey: string;
}) {
  const { placeName, lat, lng, match, reports, confidence, radius, datasetKey } = args;
  const created = new Date().toLocaleString();

  const bullets: string[] = [];
  bullets.push(`Location: ${placeName}`);
  bullets.push(`Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
  bullets.push(`Dataset loaded: ${datasetKey || "—"}`);
  bullets.push(`Radius used for counts: ${Math.round(radius)}m`);

  if (match) {
    bullets.push(`Zonal Value: ₱ ${money(match.zonalValue)} (${tier(match.zonalValue)} tier)`);
    bullets.push(`Classification: ${match.classification}`);
    bullets.push(`Area: ${match.barangay}, ${match.municipality}, ${match.province}`);
    bullets.push(`Vicinity: ${match.vicinity}`);
    bullets.push(`Match confidence: ${confidence}`);
  } else {
    bullets.push("Zonal Value: No selected record");
  }

  if (reports) {
    bullets.push(
      `Facilities: Hosp ${reports.hospitals}, Schools ${reports.schools}, Police ${reports.police}, Fire ${reports.fire}, Pharm ${reports.pharmacy}, Bank ${reports.bank}, Market ${reports.market}, Mall ${reports.mall}, Transport ${reports.transport}`
    );
  }

  return {
    created,
    bullets,
    narrative: [
      "This report is generated from the selected map coordinate, the loaded dataset (province/city), and OpenStreetMap facility counts.",
      "Use this as an initial assessment and validate with official records before final decisions.",
    ],
    bestUse:
      match?.classification?.toUpperCase() === "CR"
        ? "Commercial / corridor-oriented potential (subject to local policy)."
        : match?.classification?.toUpperCase() === "RR"
        ? "Residential-focused suitability (subject to local policy)."
        : "General suitability; confirm classification meaning/policy.",
    riskNotes: ["Validate zonal values with official records.", "OSM facility counts depend on map completeness."],
    comparableZones: match
      ? `Compare within ${match.municipality} with classification ${match.classification}; check vicinities with similar tiers.`
      : "Select a zonal record to enable comparisons.",
  };
}

function ReportModal({
  open,
  onClose,
  title,
  report,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  report: ReturnType<typeof makeReport> | null;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !report) return null;

  const onPrint = () => {
    const w = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
    if (!w) return;

    const safe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const bullets = report.bullets.map((b) => `<li>${safe(b)}</li>`).join("");
    const narrative = report.narrative.map((p) => `<p>${safe(p)}</p>`).join("");
    const risks = report.riskNotes.map((r) => `<li>${safe(r)}</li>`).join("");

    w.document.write(`
      <html><head><meta charset="utf-8" />
      <title>${safe(title)}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color:#111; }
        h1 { font-size: 18px; margin:0 0 6px; }
        .meta { color:#555; font-size:12px; margin-bottom:16px; }
        h2 { font-size:14px; margin:18px 0 8px; }
        .box { border:1px solid #ddd; border-radius:10px; padding:14px; }
        ul { margin:8px 0 0 18px; }
        p { line-height:1.55; margin:8px 0; }
      </style></head>
      <body>
        <h1>${safe(title)}</h1>
        <div class="meta">Generated: ${safe(report.created)}</div>
        <h2>Executive Summary</h2><div class="box"><ul>${bullets}</ul></div>
        <h2>Full Narrative</h2><div class="box">${narrative}</div>
        <h2>Best Use</h2><div class="box">${safe(report.bestUse)}</div>
        <h2>Comparable Zones</h2><div class="box">${safe(report.comparableZones)}</div>
        <h2>Risk Notes</h2><div class="box"><ul>${risks}</ul></div>
        <script>window.onload=function(){window.print();window.close();};</script>
      </body></html>
    `);
    w.document.close();
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-slate-900">{title}</div>
            <div className="mt-1 text-xs text-slate-500">Generated: {report.created}</div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onPrint}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
            >
              Print
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        <div className="max-h-[70vh] overflow-auto px-5 py-4 space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-900">Executive Summary</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-black">
              {report.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Main ---------------- */

const RADIUS_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "500m", value: 500 },
  { label: "1km", value: 1000 },
  { label: "1.5km", value: 1500 },
  { label: "2km", value: 2000 },
  { label: "5km", value: 5000 },
];

export default function Page() {
  const [manifest, setManifest] = useState<Manifest | null>(null);

  const [rows, setRows] = useState<Row[]>([]);
  const [activeKey, setActiveKey] = useState<string>("");
  const [datasetLoading, setDatasetLoading] = useState<boolean>(true);

  const [q, setQ] = useState("");
  const [geo, setGeo] = useState<Geo | null>(null);

  const [suggestions, setSuggestions] = useState<NominatimSuggestion[]>([]);
  const [showSug, setShowSug] = useState(false);
  const autoTimerRef = useRef<any>(null);

  // Filters
  const [fMunicipality, setFMunicipality] = useState("");
  const [fBarangay, setFBarangay] = useState("");
  const [fClass, setFClass] = useState("");

  // Record search + pagination
  const [listQuery, setListQuery] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  const [match, setMatch] = useState<Row | null>(null);
  const [topMatches, setTopMatches] = useState<Array<{ row: Row; score: number }>>([]);

  const [radius, setRadius] = useState<number>(1500);
  const [reports, setReports] = useState<Reports | null>(null);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportData, setReportData] = useState<ReturnType<typeof makeReport> | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [recenterKey, setRecenterKey] = useState(0);

  const [highlightLine, setHighlightLine] = useState<HighlightLine | null>(null);
  const [highlightKey, setHighlightKey] = useState(0);
  const [highlightLoading, setHighlightLoading] = useState(false);
  const [highlightMsg, setHighlightMsg] = useState<string | null>(null);

  const nominatimCtlRef = useRef<AbortController | null>(null);
  const overpassCtlRef = useRef<AbortController | null>(null);

  const lastDragReportAtRef = useRef<number>(0);

  // load manifest once
  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        setDatasetLoading(true);
        const m = await fetchManifest(ctl.signal);
        setManifest(m);
        setErr(null);

        const firstKey = Object.keys(m)[0];
        if (firstKey) {
          const r = await loadRows(m, firstKey, ctl.signal);
          setRows(r);
          setActiveKey(firstKey);
          setMatch(null);
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setErr(String(e?.message ?? "Failed to load manifest"));
      } finally {
        setDatasetLoading(false);
      }
    })();
    return () => ctl.abort();
  }, []);

  // autocomplete debounce
  useEffect(() => {
    const text = q.trim();
    if (!text || text.length < 3) {
      setSuggestions([]);
      return;
    }

    if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    autoTimerRef.current = setTimeout(async () => {
      try {
        nominatimCtlRef.current?.abort();
        const ctl = new AbortController();
        nominatimCtlRef.current = ctl;

        const res = await nominatimSearch(text, 5, ctl.signal);
        setSuggestions(res);
      } catch {}
    }, 350);

    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    };
  }, [q]);

  // reset cascades + paging
  useEffect(() => {
    setFBarangay("");
    setFClass("");
    setPage(1);
  }, [fMunicipality]);

  useEffect(() => {
    setFClass("");
    setPage(1);
  }, [fBarangay]);

  useEffect(() => {
    setPage(1);
  }, [fClass, listQuery, activeKey]);

  // options from current dataset
  const municipalityOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.municipality))).sort(), [rows]);

  const barangayOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      if (fMunicipality && norm(r.municipality) !== norm(fMunicipality)) return;
      set.add(r.barangay);
    });
    return Array.from(set).sort();
  }, [rows, fMunicipality]);

  const classOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      if (fMunicipality && norm(r.municipality) !== norm(fMunicipality)) return;
      if (fBarangay && norm(r.barangay) !== norm(fBarangay)) return;
      set.add(r.classification);
    });
    return Array.from(set).sort();
  }, [rows, fMunicipality, fBarangay]);

  // filtered list
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (fMunicipality && norm(r.municipality) !== norm(fMunicipality)) return false;
      if (fBarangay && norm(r.barangay) !== norm(fBarangay)) return false;
      if (fClass && norm(r.classification) !== norm(fClass)) return false;

      const qx = norm(listQuery);
      if (qx) {
        const hay = norm(`${r.region} ${r.province} ${r.municipality} ${r.barangay} ${r.street} ${r.vicinity} ${r.classification}`);
        if (!hay.includes(qx)) return false;
      }
      return true;
    });
  }, [rows, fMunicipality, fBarangay, fClass, listQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pagedRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, page]);

  const centerTuple: LatLngTuple = geo ? [geo.lat, geo.lng] : [14.5995, 120.9842];

  const confidence: "High" | "Medium" | "Low" | "—" = useMemo(() => {
    const top = topMatches[0]?.score ?? 0;
    if (!top) return "—";
    if (top > 700) return "High";
    if (top > 350) return "Medium";
    return "Low";
  }, [topMatches]);

  async function ensureDataset(g: Geo, signal?: AbortSignal): Promise<Row[]> {
    if (!manifest) throw new Error("Manifest not loaded yet.");

    const key = detectDatasetKey(g.address);
    if (!key) throw new Error("Could not detect province/city from this location.");

    const path = manifest[key];
    if (!path) {
      const city = detectCityName(g.address);
      const prov = detectProvinceName(g.address);
      throw new Error(`No CSV mapped for detected area. city="${city}" province="${prov}" -> key="${key}". Add it to manifest.json.`);
    }

    if (key === activeKey && rows.length) return rows;

    setDatasetLoading(true);
    try {
      const newRows = await loadRows(manifest, key, signal);
      setRows(newRows);
      setActiveKey(key);

      // reset filters on dataset switch
      setFMunicipality("");
      setFBarangay("");
      setFClass("");
      setListQuery("");
      setPage(1);

      return newRows;
    } finally {
      setDatasetLoading(false);
    }
  }

  async function updateMatching(queryText: string, allRows: Row[]) {
    if (!allRows.length) {
      setTopMatches([]);
      setMatch(null);
      return;
    }

    const scored = allRows
      .map((r) => ({ row: r, score: scoreRow(r, queryText) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    setTopMatches(scored);
    setMatch(scored[0]?.row ?? null);
  }

  async function updateReports(lat: number, lng: number) {
    overpassCtlRef.current?.abort();
    const ctl = new AbortController();
    overpassCtlRef.current = ctl;

    const r = await fetchReports(lat, lng, radius, ctl.signal);
    setReports(r);
  }

  async function runFullPipeline(g: Geo, queryText: string, opts?: { recenter?: boolean }) {
    setGeo(g);
    if (opts?.recenter) setRecenterKey((k) => k + 1);

    // clear highlight on new place selection
    setHighlightLine(null);
    setHighlightKey((k) => k + 1);
    setHighlightMsg(null);

    const datasetRows = await ensureDataset(g);
    await updateMatching(queryText, datasetRows);
    await updateReports(g.lat, g.lng);
  }

  async function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;

    setLoading(true);
    setErr(null);
    setShowSug(false);

    try {
      nominatimCtlRef.current?.abort();
      const ctl = new AbortController();
      nominatimCtlRef.current = ctl;

      const g = await nominatimGeocodeTop(query, ctl.signal);
      await runFullPipeline(g, query, { recenter: true });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setErr(String(e?.message ?? "Something went wrong"));
    } finally {
      setLoading(false);
    }
  }

  async function onPickSuggestion(s: NominatimSuggestion) {
    setShowSug(false);
    setLoading(true);
    setErr(null);

    try {
      const g: Geo = { displayName: s.display_name, lat: Number(s.lat), lng: Number(s.lon), address: s.address ?? {} };
      setQ(s.display_name);
      await runFullPipeline(g, s.display_name, { recenter: true });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setErr(String(e?.message ?? "Something went wrong"));
    } finally {
      setLoading(false);
    }
  }

  async function onMapPick(lat: number, lng: number, source: PickSource) {
    setErr(null);
    setShowSug(false);

    if (source === "drag") {
      const now = Date.now();
      if (now - lastDragReportAtRef.current < 1100) return;
      lastDragReportAtRef.current = now;

      setGeo({ displayName: "Pinned location", lat, lng });

      setLoading(true);
      try {
        await updateReports(lat, lng);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setErr(String(e?.message ?? "Reports temporarily unavailable"));
      } finally {
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      nominatimCtlRef.current?.abort();
      const ctl = new AbortController();
      nominatimCtlRef.current = ctl;

      const g = await nominatimReverse(lat, lng, ctl.signal);
      setQ(g.displayName);
      await runFullPipeline(g, g.displayName, { recenter: false });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setErr(String(e?.message ?? "Something went wrong"));
    } finally {
      setLoading(false);
    }
  }

  async function focusRecordOnMap(r: Row) {
    setErr(null);
    setLoading(true);

    // clear old highlight when switching record
    setHighlightLine(null);
    setHighlightKey((k) => k + 1);
    setHighlightMsg(null);

    try {
      nominatimCtlRef.current?.abort();
      const ctl = new AbortController();
      nominatimCtlRef.current = ctl;

      const pt = await recordToPoint(r, ctl.signal);

      setGeo({
        displayName: pt.label,
        lat: pt.lat,
        lng: pt.lng,
        address: { city: r.municipality, province: r.province },
      });
      setQ(pt.label);
      setRecenterKey((k) => k + 1);

      await updateReports(pt.lat, pt.lng);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setErr(String(e?.message ?? "Failed to locate this record on the map"));
    } finally {
      setLoading(false);
    }
  }

  async function onLoadHighlight() {
    if (!match) return;

    setHighlightLoading(true);
    setHighlightMsg(null);

    try {
      overpassCtlRef.current?.abort();
      const ctl = new AbortController();
      overpassCtlRef.current = ctl;

      const res = await loadVicinityHighlight(match, ctl.signal);
      if (!res.highlight) {
        setHighlightLine(null);
        setHighlightKey((k) => k + 1);
        setHighlightMsg(res.warning ?? "No highlight found.");
        return;
      }

      setHighlightLine(res.highlight);
      setHighlightKey((k) => k + 1);
      setHighlightMsg(res.warning ?? null);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      const msg = String(e?.message ?? "Failed to load highlight");
      setHighlightMsg(msg);
    } finally {
      setHighlightLoading(false);
    }
  }

  // radius changes => refresh reports only
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!geo) return;
      try {
        const r = await fetchReports(geo.lat, geo.lng, radius);
        if (!cancelled) setReports(r);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? "Reports temporarily unavailable"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [radius, geo]);

  const onGenerateReport = () => {
    if (!geo) return;
    const rep = makeReport({
      placeName: geo.displayName,
      lat: geo.lat,
      lng: geo.lng,
      match,
      reports,
      confidence,
      radius,
      datasetKey: activeKey,
    });
    setReportData(rep);
    setReportOpen(true);
  };

  const radiusLabel = RADIUS_OPTIONS.find((o) => o.value === radius)?.label ?? `${radius}m`;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">PH Zonal Finder</h1>
            <p className="mt-1 text-sm text-slate-600">
              Search / click map → auto loads dataset from <code>/public/zonal</code> via manifest
            </p>
            <div className="mt-2 text-xs text-slate-500">
              Active dataset: {datasetLoading ? "loading…" : activeKey ? `${activeKey} (${rows.length} rows)` : "none"}
            </div>
          </div>

          {/* Search */}
          <form onSubmit={onSearchSubmit} className="relative w-full max-w-3xl">
            <div className="flex gap-2">
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setShowSug(true);
                }}
                onFocus={() => setShowSug(true)}
                placeholder="Search place (e.g., Baguio City, Laoag City)…"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-black placeholder:text-slate-400 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-200"
              />
              <button
                disabled={loading || !manifest}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
                type="submit"
              >
                {loading ? "Loading…" : "Search"}
              </button>
            </div>

            {showSug && suggestions.length > 0 ? (
              <div className="absolute z-50 mt-2 w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onPickSuggestion(s)}
                    className="block w-full border-b border-slate-100 px-4 py-3 text-left text-sm hover:bg-slate-50"
                  >
                    <div className="font-medium text-slate-900 line-clamp-1">{s.display_name}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {Number(s.lat).toFixed(5)}, {Number(s.lon).toFixed(5)}
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </form>

          {/* Filters + Radius */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
            <div className="lg:col-span-1">
              <div className="text-xs font-semibold text-slate-600">Radius</div>
              <select
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-black"
              >
                {RADIUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-xs font-semibold text-slate-600">Municipality</div>
                <select
                  value={fMunicipality}
                  onChange={(e) => setFMunicipality(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-black"
                >
                  <option value="">All</option>
                  {municipalityOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600">Barangay</div>
                <select
                  value={fBarangay}
                  onChange={(e) => setFBarangay(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-black"
                >
                  <option value="">All</option>
                  {barangayOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600">Classification</div>
                <select
                  value={fClass}
                  onChange={(e) => setFClass(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-black"
                >
                  <option value="">All</option>
                  {classOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {err ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              {err}
              {looksRateLimited(err) || looksOverpassTimeout(err) ? (
                <div className="mt-2 text-xs text-rose-700">
                  Overpass can timeout/rate-limit. Use “Load road highlight” only when needed.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Main layout */}
        <div className="mt-6 grid grid-cols-12 gap-4">
          {/* Left */}
          <div className="col-span-12 lg:col-span-4 space-y-4">
            <Card title="Selected Zonal Record">
              {match ? (
                <>
                  <div className="text-2xl font-semibold text-slate-900">₱ {money(match.zonalValue)}</div>
                  <div className="mt-2 text-xs text-slate-500">Confidence: {confidence}</div>

                  <div className="mt-3 space-y-1">
                    <div>
                      <span className="text-slate-500">Municipality:</span> {match.municipality}
                    </div>
                    <div>
                      <span className="text-slate-500">Barangay:</span> {match.barangay}
                    </div>
                    <div>
                      <span className="text-slate-500">Street:</span> {match.street}
                    </div>
                    <div>
                      <span className="text-slate-500">Vicinity:</span> {match.vicinity}
                    </div>
                    <div>
                      <span className="text-slate-500">Class:</span> {match.classification}
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={onLoadHighlight}
                      disabled={highlightLoading}
                      className={clsx(
                        "rounded-xl px-3 py-2 text-sm font-medium shadow-sm transition",
                        highlightLoading ? "bg-slate-200 text-slate-500" : "bg-emerald-600 text-white hover:bg-emerald-700"
                      )}
                    >
                      {highlightLoading ? "Loading…" : "Load road highlight"}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setHighlightLine(null);
                        setHighlightKey((k) => k + 1);
                        setHighlightMsg(null);
                      }}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                    >
                      Clear highlight
                    </button>
                  </div>

                  {highlightMsg ? <div className="mt-2 text-xs text-slate-500">{highlightMsg}</div> : null}
                </>
              ) : (
                <div className="text-sm text-slate-500">Search/click map to auto-select best record.</div>
              )}

              <button
                type="button"
                onClick={onGenerateReport}
                disabled={!geo}
                className={clsx(
                  "mt-4 w-full rounded-xl px-4 py-2 text-sm font-medium shadow-sm transition",
                  geo ? "bg-slate-900 text-white hover:bg-slate-800" : "bg-slate-200 text-slate-500 cursor-not-allowed"
                )}
              >
                Generate Printable Report
              </button>
            </Card>

            <Card title="Records">
              <input
                value={listQuery}
                onChange={(e) => setListQuery(e.target.value)}
                placeholder="Filter records (barangay/vicinity/class)…"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-black placeholder:text-slate-400"
              />

              <div className="mt-2 text-xs text-slate-500">
                Showing <b>{filteredRows.length}</b> records • Page {page} / {totalPages}
              </div>

              <div className="mt-2 overflow-hidden rounded-xl border border-slate-200">
                <div className="max-h-[45vh] overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-xs text-slate-600">
                      <tr>
                        <th className="px-3 py-2">Municipality</th>
                        <th className="px-3 py-2">Barangay</th>
                        <th className="px-3 py-2">Vicinity</th>
                        <th className="px-3 py-2">Class</th>
                        <th className="px-3 py-2">Zonal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedRows.map((r, i) => {
                        const active = match === r;
                        return (
                          <tr
                            key={`${r.municipality}-${r.barangay}-${r.vicinity}-${r.classification}-${i}`}
                            className={clsx("cursor-pointer border-t border-slate-100 hover:bg-slate-50", active && "bg-slate-100")}
                            onClick={() => {
                              setMatch(r);
                              focusRecordOnMap(r);
                            }}
                          >
                            <td className="px-3 py-2 text-black">{r.municipality}</td>
                            <td className="px-3 py-2 text-black">{r.barangay}</td>
                            <td className="px-3 py-2 text-black">{r.vicinity}</td>
                            <td className="px-3 py-2 text-black">{r.classification}</td>
                            <td className="px-3 py-2 text-black">₱ {money(r.zonalValue)}</td>
                          </tr>
                        );
                      })}
                      {!pagedRows.length ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                            No records match your filters.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  Prev
                </button>
                <div className="text-xs text-slate-500">
                  Page {page} of {totalPages}
                </div>
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  Next
                </button>
              </div>
            </Card>
          </div>

          {/* Middle */}
          <div className="col-span-12 lg:col-span-5">
            <MapPanel
              center={centerTuple}
              label={geo?.displayName ?? "Click map or search"}
              onPick={onMapPick}
              recenterKey={recenterKey}
              highlightLine={highlightLine}
              highlightKey={highlightKey}
            />
            <div className="mt-2 text-xs text-slate-500">
              {geo ? (
                <>
                  Selected: <span className="font-medium text-slate-700">{geo.displayName}</span> • {centerTuple[0].toFixed(6)},{" "}
                  {centerTuple[1].toFixed(6)}
                </>
              ) : (
                "Search a place or click/drag the pin to set location."
              )}
            </div>
          </div>

          {/* Right */}
          <div className="col-span-12 lg:col-span-3 space-y-4">
            <Card title={`Reports (within ${radiusLabel})`}>
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Hospitals" value={reports?.hospitals ?? (loading ? "…" : "—")} />
                <Metric label="Schools" value={reports?.schools ?? (loading ? "…" : "—")} />
                <Metric label="Police" value={reports?.police ?? (loading ? "…" : "—")} />
                <Metric label="Fire" value={reports?.fire ?? (loading ? "…" : "—")} />
                <Metric label="Pharmacy" value={reports?.pharmacy ?? (loading ? "…" : "—")} />
                <Metric label="Bank" value={reports?.bank ?? (loading ? "…" : "—")} />
                <Metric label="Market" value={reports?.market ?? (loading ? "…" : "—")} />
                <Metric label="Mall" value={reports?.mall ?? (loading ? "…" : "—")} />
                <Metric label="Transport" value={reports?.transport ?? (loading ? "…" : "—")} />
              </div>
              <div className="mt-3 text-xs text-slate-500">Uses OpenStreetMap (ODbL) via Overpass.</div>
            </Card>

            <Card title="Top Matches (quick picks)">
              {topMatches.length ? (
                <div className="space-y-2">
                  {topMatches.map((m, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        setMatch(m.row);
                        focusRecordOnMap(m.row);
                      }}
                      className={clsx(
                        "w-full rounded-xl border px-3 py-2 text-left text-sm shadow-sm transition",
                        match === m.row ? "border-slate-400 bg-slate-50" : "border-slate-200 bg-white hover:bg-slate-50"
                      )}
                    >
                      <div className="font-medium text-slate-900 line-clamp-1">{m.row.vicinity}</div>
                      <div className="text-xs text-slate-500">
                        {m.row.municipality} • {m.row.barangay} • {m.row.classification} • ₱ {money(m.row.zonalValue)}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-slate-500">Search/click map to compute matches.</div>
              )}
            </Card>
          </div>
        </div>
      </div>

      <ReportModal open={reportOpen} onClose={() => setReportOpen(false)} title="Printable Place Assessment Report" report={reportData} />
    </main>
  );
}
