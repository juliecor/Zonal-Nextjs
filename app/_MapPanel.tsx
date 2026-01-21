"use client";

import React, { useEffect, useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L, { type LeafletEventHandlerFnMap } from "leaflet";

type LatLngTuple = [number, number];

const DefaultIcon = L.icon({
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function Recenter({ center }: { center: LatLngTuple }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom(), { animate: true });
  }, [center, map]);
  return null;
}

function ClickPicker({
  onPick,
}: {
  onPick?: (lat: number, lng: number, source: "click" | "drag") => void;
}) {
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
}: {
  center: LatLngTuple;
  label: string;
  onPick?: (lat: number, lng: number, source: "click" | "drag") => void;
}) {
  const markerHandlers: LeafletEventHandlerFnMap = useMemo(
    () => ({
      dragend: (e) => {
        const ll = (e.target as any).getLatLng();
        onPick?.(ll.lat, ll.lng, "drag");
      },
    }),
    [onPick]
  );

  return (
    <div className="relative z-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="h-[70vh] w-full">
        <MapContainer center={center} zoom={14} scrollWheelZoom className="h-full w-full">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <Recenter center={center} />
          <ClickPicker onPick={onPick} />

          <Marker
            position={center}
            icon={DefaultIcon}
            draggable
            eventHandlers={markerHandlers}
          >
            <Popup>{label}</Popup>
          </Marker>
        </MapContainer>
      </div>

      <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
        Tip: click map or drag pin • © OpenStreetMap contributors
      </div>
    </div>
  );
}
