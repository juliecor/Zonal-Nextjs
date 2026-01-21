"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

const MapPanel = dynamic(() => import("./_MapPanel"), { ssr: false });

type LatLngTuple = [number, number];

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

/** Supports CSV or TSV, with or without header row */
function parseZonalFile(text: string): Row[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const delimiter = lines[0].includes("\t") ? "\t" : ",";

  const splitLine = (line: string) => {
    if (delimiter === "\t") return line.split("\t").map((s) => s.trim());

    // CSV w/ quotes
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;

      if (ch === "," && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim().replace(/^"|"$/g, ""));
  };

  const first = splitLine(lines[0]).map((s) => s.toLowerCase());
  const hasHeader =
    first.includes("province") ||
    first.includes("municipality") ||
    first.includes("barangay") ||
    first.includes("zonal_value") ||
    first.includes("revenue region no.");

  const startIdx = hasHeader ? 1 : 0;

  return lines.slice(startIdx).map((line) => {
    const c = splitLine(line);
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

/* ---------------- dataset key detection (BAGUIO override) ---------------- */

function normalizeKey(s?: string | null) {
  if (!s) return "";
  return String(s)
    .trim()
    .replace(/\bprovince\b/gi, "")
    .replace(/\bprovincia\b/gi, "")
    .replace(/[\s._-]+/g, "") // remove spaces + separators
    .toUpperCase();
}

const CITY_OVERRIDES: Record<string, string> = {
  BAGUIO: "BAGUIOCITY",
  
  // add more if you want:
  // QUEZONCITY: "QUEZONCITY",
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
  return address.province || address.state || address.county || address.region || "";
}

function detectDatasetKey(address: any) {
  const cityKey = normalizeKey(detectCityName(address));
  if (CITY_OVERRIDES[cityKey]) return CITY_OVERRIDES[cityKey];

  const provKey = normalizeKey(detectProvinceName(address));
  return provKey;
}

/* ---------------- nominatim ---------------- */

async function nominatimSearch(q: string, limit = 5): Promise<NominatimSuggestion[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${limit}&q=${encodeURIComponent(
    q
  )}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Autocomplete failed");
  return (await res.json()) as NominatimSuggestion[];
}

async function nominatimGeocodeTop(q: string): Promise<Geo> {
  const results = await nominatimSearch(q, 1);
  if (!results.length) throw new Error("No location found");
  const top = results[0];
  return {
    displayName: top.display_name,
    lat: Number(top.lat),
    lng: Number(top.lon),
    address: top.address ?? {},
  };
}

async function nominatimReverse(lat: number, lng: number): Promise<Geo> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${encodeURIComponent(
    String(lat)
  )}&lon=${encodeURIComponent(String(lng))}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
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

async function fetchManifest(): Promise<Manifest> {
  // ✅ no-store avoids the dev caching issue you hit
  const res = await fetch("/zonal/manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load /zonal/manifest.json");
  return (await res.json()) as Manifest;
}

const datasetCache = new Map<string, Row[]>();

async function loadRows(manifest: Manifest, key: string): Promise<Row[]> {
  if (datasetCache.has(key)) return datasetCache.get(key)!;

  const path = manifest[key];
  if (!path) throw new Error(`No CSV mapped for key: ${key}`);

  const res = await fetch(path, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Failed to load CSV: ${path}`);

  const text = await res.text();
  const rows = parseZonalFile(text);
  if (!rows.length) throw new Error(`Loaded ${path} but got 0 rows`);

  datasetCache.set(key, rows);
  return rows;
}

/* ---------------- overpass reports (with fallback endpoints) ---------------- */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function looksRateLimited(msg: string) {
  const m = msg.toLowerCase();
  return m.includes("rate_limited") || m.includes("too many") || m.includes("429") || m.includes("quota");
}

async function postOverpass(endpoint: string, query: string) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Overpass error (${res.status}): ${text.slice(0, 220)}`);

  try {
    return JSON.parse(text) as { elements?: Array<{ type: string; id: number; tags?: Record<string, string> }> };
  } catch {
    throw new Error(`Overpass returned non-JSON: ${text.slice(0, 220)}`);
  }
}

async function overpassWithFallback(query: string) {
  let lastErr: any = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      return await postOverpass(ep, query);
    } catch (e: any) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr ?? new Error("Overpass failed");
}

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

async function fetchReports(lat: number, lng: number, radius: number): Promise<Reports> {
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
    overpassWithFallback(amenityQuery),
    overpassWithFallback(mallQuery),
    overpassWithFallback(transportQuery),
  ]);

  const counts = {
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
    if (a && (counts as any)[a] !== undefined) (counts as any)[a]++;
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

/* ---------------- matching (lightweight) ---------------- */

function tokenSet(s: string) {
  return new Set(norm(s).split(" ").filter((t) => t.length >= 3));
}

function scoreRow(row: Row, queryText: string, hints?: { municipality?: string; province?: string }) {
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

  if (hints?.province && norm(row.province) === norm(hints.province)) s += 80;
  if (hints?.municipality && norm(row.municipality) === norm(hints.municipality)) s += 80;

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

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

/* ---------------- printable report modal ---------------- */

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
    riskNotes: [
      "Validate zonal values with official records.",
      "OSM facility counts depend on map completeness.",
      "Geocoding may represent general area; confirm parcel-level coordinates.",
    ],
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

    const safe = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const bullets = report.bullets.map((b) => `<li>${safe(b)}</li>`).join("");
    const narrative = report.narrative.map((p) => `<p>${safe(p)}</p>`).join("");
    const risks = report.riskNotes.map((r) => `<li>${safe(r)}</li>`).join("");

    w.document.write(`
      <html>
        <head>
          <title>${safe(title)}</title>
          <meta charset="utf-8" />
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
            h1 { font-size: 18px; margin: 0 0 6px; }
            .meta { color: #555; font-size: 12px; margin-bottom: 16px; }
            h2 { font-size: 14px; margin: 18px 0 8px; }
            .box { border: 1px solid #ddd; border-radius: 10px; padding: 14px; }
            ul { margin: 8px 0 0 18px; }
            p { line-height: 1.55; margin: 8px 0; }
          </style>
        </head>
        <body>
          <h1>${safe(title)}</h1>
          <div class="meta">Generated: ${safe(report.created)}</div>

          <h2>Executive Summary</h2>
          <div class="box"><ul>${bullets}</ul></div>

          <h2>Full Narrative</h2>
          <div class="box">${narrative}</div>

          <h2>Best Use</h2>
          <div class="box">${safe(report.bestUse)}</div>

          <h2>Comparable Zones</h2>
          <div class="box">${safe(report.comparableZones)}</div>

          <h2>Risk Notes</h2>
          <div class="box"><ul>${risks}</ul></div>

          <script>
            window.onload = function() { window.print(); window.close(); };
          </script>
        </body>
      </html>
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

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Full Narrative</div>
            <div className="mt-2 space-y-2 text-sm leading-6 text-black">
              {report.narrative.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-sm font-semibold text-slate-900">Best Use</div>
              <div className="mt-2 text-sm leading-6 text-black">{report.bestUse}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-sm font-semibold text-slate-900">Risk Notes</div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-black">
                {report.riskNotes.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">Comparable Zones</div>
            <div className="mt-2 text-sm text-black">{report.comparableZones}</div>
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

  const lastActionRef = useRef<number>(0);
  const dragDebounceRef = useRef<any>(null);

  // load manifest once
  useEffect(() => {
    (async () => {
      try {
        setDatasetLoading(true);
        const m = await fetchManifest();
        setManifest(m);
        setErr(null);

        // load first dataset so UI isn't empty
        const firstKey = Object.keys(m)[0];
        if (firstKey) {
          const r = await loadRows(m, firstKey);
          setRows(r);
          setActiveKey(firstKey);
          setMatch(null);
        }
      } catch (e: any) {
        setErr(String(e?.message ?? "Failed to load manifest"));
      } finally {
        setDatasetLoading(false);
      }
    })();
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
        const res = await nominatimSearch(text, 5);
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
  const municipalityOptions = useMemo(() => {
    return Array.from(new Set(rows.map((r) => r.municipality))).sort();
  }, [rows]);

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

      const q = norm(listQuery);
      if (q) {
        const hay = norm(
          `${r.region} ${r.province} ${r.municipality} ${r.barangay} ${r.street} ${r.vicinity} ${r.classification} ${r.zonalValue}`
        );
        if (!hay.includes(q)) return false;
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

  async function ensureDataset(g: Geo) {
    if (!manifest) throw new Error("Manifest not loaded yet.");

    const key = detectDatasetKey(g.address);
    if (!key) throw new Error("Could not detect province/city from this location.");

    const path = manifest[key];
    if (!path) {
      const city = detectCityName(g.address);
      const prov = detectProvinceName(g.address);
      throw new Error(
        `No CSV mapped for detected area. city="${city}" province="${prov}" -> key="${key}". Add it to manifest.json.`
      );
    }

    if (key === activeKey && rows.length) return;

    setDatasetLoading(true);
    try {
      const newRows = await loadRows(manifest, key);
      setRows(newRows);
      setActiveKey(key);
      setMatch(null);
      setTopMatches([]);

      // reset filters on dataset switch
      setFMunicipality("");
      setFBarangay("");
      setFClass("");
      setListQuery("");
      setPage(1);
    } finally {
      setDatasetLoading(false);
    }
  }

  async function updateMatching(queryText: string, g?: Geo) {
    if (!rows.length) {
      setTopMatches([]);
      setMatch(null);
      return;
    }

    const hints = g
      ? {
          municipality: g.address?.city || g.address?.town || g.address?.municipality,
          province: detectProvinceName(g.address),
        }
      : undefined;

    const scored = rows
      .map((r) => ({ row: r, score: scoreRow(r, queryText, hints) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    setTopMatches(scored);
    if (!match) setMatch(scored[0]?.row ?? null);
  }

  async function updateReports(lat: number, lng: number) {
    const r = await fetchReports(lat, lng, radius);
    setReports(r);
  }

  async function runFullPipeline(g: Geo, queryText: string) {
    setGeo(g);
    await ensureDataset(g);
    await updateMatching(queryText, g);
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
      const now = Date.now();
      if (now - lastActionRef.current < 900) throw new Error("Please wait a second before searching again.");
      lastActionRef.current = now;

      const g = await nominatimGeocodeTop(query);
      await runFullPipeline(g, query);
    } catch (e: any) {
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
      const g: Geo = {
        displayName: s.display_name,
        lat: Number(s.lat),
        lng: Number(s.lon),
        address: s.address ?? {},
      };
      setQ(s.display_name);
      await runFullPipeline(g, s.display_name);
    } catch (e: any) {
      setErr(String(e?.message ?? "Something went wrong"));
    } finally {
      setLoading(false);
    }
  }

  async function onMapPick(lat: number, lng: number, source: "click" | "drag") {
    setErr(null);
    setShowSug(false);

    if (source === "drag") {
      const now = Date.now();
      if (now - lastActionRef.current < 400) return;
      lastActionRef.current = now;

      setGeo({ displayName: "Pinned location (dragging)", lat, lng });

      // live reports while dragging
      setLoading(true);
      try {
        await updateReports(lat, lng);
      } catch (e: any) {
        setErr(String(e?.message ?? "Reports temporarily unavailable"));
      } finally {
        setLoading(false);
      }

      // debounce reverse geocode + dataset switch
      if (dragDebounceRef.current) clearTimeout(dragDebounceRef.current);
      dragDebounceRef.current = setTimeout(async () => {
        setLoading(true);
        try {
          const g = await nominatimReverse(lat, lng);
          setQ(g.displayName);
          await runFullPipeline(g, g.displayName);
        } catch (e: any) {
          setErr(String(e?.message ?? "Reverse geocoding failed"));
        } finally {
          setLoading(false);
        }
      }, 900);

      return;
    }

    setLoading(true);
    try {
      const g = await nominatimReverse(lat, lng);
      setQ(g.displayName);
      await runFullPipeline(g, g.displayName);
    } catch (e: any) {
      setErr(String(e?.message ?? "Something went wrong"));
    } finally {
      setLoading(false);
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
              Active dataset:{" "}
              {datasetLoading ? "loading…" : activeKey ? `${activeKey} (${rows.length} rows)` : "none"}
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
              {looksRateLimited(err) ? (
                <div className="mt-2 text-xs text-rose-700">
                  Overpass rate-limited. Try again later or reduce rapid dragging/searching.
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
                </>
              ) : (
                <div className="text-sm text-slate-500">Click a row in “Records” to select.</div>
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
                            className={clsx(
                              "cursor-pointer border-t border-slate-100 hover:bg-slate-50",
                              active && "bg-slate-100"
                            )}
                            onClick={() => setMatch(r)}
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
            <MapPanel center={centerTuple} label={geo?.displayName ?? "Click map or search"} onPick={onMapPick} />
            <div className="mt-2 text-xs text-slate-500">
              {geo ? (
                <>
                  Selected: <span className="font-medium text-slate-700">{geo.displayName}</span> •{" "}
                  {centerTuple[0].toFixed(6)}, {centerTuple[1].toFixed(6)}
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
              <div className="mt-3 text-xs text-slate-500">
                Uses OpenStreetMap (ODbL) via Overpass. Rate limits can happen.
              </div>
            </Card>

            <Card title="Top Matches (quick picks)">
              {topMatches.length ? (
                <div className="space-y-2">
                  {topMatches.map((m, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setMatch(m.row)}
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
                <div className="text-sm text-slate-500">Search a place to compute matches.</div>
              )}
            </Card>
          </div>
        </div>
      </div>

      <ReportModal open={reportOpen} onClose={() => setReportOpen(false)} title="Printable Place Assessment Report" report={reportData} />
    </main>
  );
}
