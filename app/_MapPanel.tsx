"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from "react-leaflet";
import L, { type LeafletEventHandlerFnMap } from "leaflet";

type LatLngTuple = [number, number];
type PickSource = "click" | "drag" | "dragend";

type HighlightLine = {
  paths: LatLngTuple[][];
  label: string;
};

const DefaultIcon = L.icon({
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function Recenter({ center, recenterKey }: { center: LatLngTuple; recenterKey: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom(), { animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterKey]);
  return null;
}

function FitPolyline({ line, highlightKey }: { line: HighlightLine | null; highlightKey: number }) {
  const map = useMap();

  useEffect(() => {
    if (!line?.paths?.length) return;

    const all: LatLngTuple[] = [];
    for (const p of line.paths) all.push(...p);
    if (!all.length) return;

    const bounds = L.latLngBounds(all as any);
    map.fitBounds(bounds, { padding: [30, 30] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey]);

  return null;
}

function ClickPicker({ onPick }: { onPick?: (lat: number, lng: number, source: PickSource) => void }) {
  useMapEvents({
    click(e) {
      onPick?.(e.latlng.lat, e.latlng.lng, "click");
    },
  });
  return null;
}

export default function MapPanel({
  center,
  label,
  onPick,
  recenterKey,
  highlightLine,
  highlightKey,
}: {
  center: LatLngTuple;
  label: string;
  onPick?: (lat: number, lng: number, source: PickSource) => void;
  recenterKey: number;
  highlightLine: HighlightLine | null;
  highlightKey: number;
}) {
  const lastDragAtRef = useRef(0);

  const markerHandlers: LeafletEventHandlerFnMap = useMemo(
    () => ({
      drag: (e) => {
        const now = Date.now();
        if (now - lastDragAtRef.current < 300) return;
        lastDragAtRef.current = now;

        const ll = (e.target as any).getLatLng();
        onPick?.(ll.lat, ll.lng, "drag");
      },
      dragend: (e) => {
        const ll = (e.target as any).getLatLng();
        onPick?.(ll.lat, ll.lng, "dragend");
      },
    }),
    [onPick]
  );

  return (
    <div className="relative z-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="h-[70vh] w-full">
        <MapContainer center={center} zoom={14} scrollWheelZoom className="h-full w-full">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

          <Recenter center={center} recenterKey={recenterKey} />
          <FitPolyline line={highlightLine} highlightKey={highlightKey} />
          <ClickPicker onPick={onPick} />

          {highlightLine?.paths?.length
            ? highlightLine.paths.map((p, idx) => (
                <Polyline key={idx} positions={p as any} pathOptions={{ color: "#ef4444", weight: 5, opacity: 0.85 }} />
              ))
            : null}

          <Marker position={center} icon={DefaultIcon} draggable eventHandlers={markerHandlers}>
            <Popup>
              <div className="text-sm">{label}</div>
              {highlightLine?.label ? <div className="mt-1 text-xs text-slate-500">{highlightLine.label}</div> : null}
            </Popup>
          </Marker>
        </MapContainer>
      </div>

      <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
        Tip: click map or drag pin • Use “Load road highlight” for line • © OpenStreetMap contributors
      </div>
    </div>
  );
}
