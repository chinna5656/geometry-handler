import MapboxDraw from "@mapbox/mapbox-gl-draw";
import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";

import {
  createNdviRaster,
  fetchPlots,
  inspectNdviPixel
} from "../lib/api.js";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? "";

const MAP_STYLE = mapboxgl.accessToken
  ? "mapbox://styles/mapbox/satellite-streets-v12"
  : {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "(c) OpenStreetMap contributors"
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }]
    };

export function MapView({ activeRaster, onPolygonChange, onRasterReady }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const rasterRef = useRef(null);
  const [drawnPolygon, setDrawnPolygon] = useState(null);
  const [status, setStatus] = useState("Loading map");

  useEffect(() => {
    rasterRef.current = activeRaster;
  }, [activeRaster]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [100.506, 13.761],
      zoom: 13,
      minZoom: 8,
      maxZoom: 18
    });

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: {
        polygon: true,
        trash: true
      },
      defaultMode: "draw_polygon"
    });

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(draw, "top-right");
    mapRef.current = map;

    map.on("load", async () => {
      setStatus("Loading plot boundaries");
      const plots = await fetchPlots();

      map.addSource("plots", {
        type: "geojson",
        data: plots
      });

      map.addLayer({
        id: "plot-fill",
        type: "fill",
        source: "plots",
        paint: {
          "fill-color": "#10b981",
          "fill-opacity": 0.12
        }
      });

      map.addLayer({
        id: "plot-outline",
        type: "line",
        source: "plots",
        paint: {
          "line-color": "#047857",
          "line-width": 2
        }
      });

      setStatus("Draw a plot polygon");
    });

    function syncDrawnPolygon() {
      const features = draw.getAll().features;
      const polygon = features.find((feature) => feature.geometry.type === "Polygon");
      setDrawnPolygon(polygon ?? null);
      onPolygonChange(polygon ?? null);
      setStatus(polygon ? "Polygon ready for NDVI" : "Draw a plot polygon");
    }

    map.on("draw.create", syncDrawnPolygon);
    map.on("draw.update", syncDrawnPolygon);
    map.on("draw.delete", syncDrawnPolygon);
    map.on("click", handleMapClick);

    return () => map.remove();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeRaster) {
      return;
    }

    const sourceId = "ndvi-raster";
    const layerId = "ndvi-raster-layer";

    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }

    map.addSource(sourceId, {
      type: "raster",
      tiles: [activeRaster.tile_url],
      tileSize: 256
    });

    map.addLayer(
      {
        id: layerId,
        type: "raster",
        source: sourceId,
        paint: {
          "raster-opacity": 0.78,
          "raster-resampling": "nearest"
        }
      },
      map.getLayer("plot-outline") ? "plot-outline" : undefined
    );

    map.fitBounds(
      [
        [activeRaster.bounds[0], activeRaster.bounds[1]],
        [activeRaster.bounds[2], activeRaster.bounds[3]]
      ],
      { padding: 64, maxZoom: 16 }
    );
  }, [activeRaster]);

  async function handleGenerateRaster() {
    if (!drawnPolygon) {
      setStatus("Draw a polygon first");
      return;
    }

    setStatus("Fetching Sentinel-2 and computing NDVI");
    try {
      const raster = await createNdviRaster({
        polygon: drawnPolygon,
        daysBack: 90,
        maxCloudCover: 20
      });
      onRasterReady(raster);
      setStatus("NDVI overlay ready. Click inside it to inspect pixels.");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function handleMapClick(event) {
    const raster = rasterRef.current;
    if (!raster) {
      return;
    }

    const longitude = event.lngLat.lng;
    const latitude = event.lngLat.lat;

    try {
      const result = await inspectNdviPixel({
        sessionId: raster.session_id,
        longitude,
        latitude
      });

      new mapboxgl.Popup()
        .setLngLat([longitude, latitude])
        .setHTML(
          `<strong>NDVI: ${result.ndvi.toFixed(2)}</strong><br/>` +
            `${result.class_name}<br/>` +
            `Lon: ${result.longitude.toFixed(6)}<br/>` +
            `Lat: ${result.latitude.toFixed(6)}`
        )
        .addTo(mapRef.current);
    } catch (error) {
      new mapboxgl.Popup()
        .setLngLat([longitude, latitude])
        .setText(error.message)
        .addTo(mapRef.current);
    }
  }

  return (
    <div className="relative h-full">
      <div ref={containerRef} className="h-full w-full" />

      <div className="absolute left-4 top-4 max-w-xl rounded bg-white px-4 py-3 shadow">
        <div className="flex items-center gap-3">
          <button
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={!drawnPolygon}
            onClick={handleGenerateRaster}
            type="button"
          >
            Generate NDVI Raster
          </button>
          <span className="text-sm text-slate-600">{status}</span>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded bg-gradient-to-r from-red-600 via-yellow-400 to-green-800" />
        <div className="mt-1 flex justify-between text-xs text-slate-500">
          <span>Stressed / bare</span>
          <span>Healthy dense crop</span>
        </div>
      </div>
    </div>
  );
}
