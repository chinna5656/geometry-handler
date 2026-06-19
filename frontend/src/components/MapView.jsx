import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";

import {
  createLstRaster,
  createNdviRaster,
  fetchPlots,
  inspectLstPixel,
  inspectNdviPixel,
  scoreCropAnomaly
} from "../lib/api.js";

const DEFAULT_CENTER = [13.761, 100.506];
const DEFAULT_ZOOM = 15;
const DEFAULT_TILE_SUBDOMAINS = "abc";
const MIN_PLOT_POLYGON_VERTICES = 4;
const RAI_PER_HECTARE = 6.25;

const BASEMAPS = {
  imagery: {
    label: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles (c) Esri"
  },
  satelliteHybrid: {
    label: "Satellite Hybrid",
    url: "https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    subdomains: ["mt0", "mt1", "mt2", "mt3"],
    attribution: "Imagery (c) Google"
  },
  light: {
    label: "Clean Light Map",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "(c) OpenStreetMap contributors"
  }
};

const TILE_OPTIONS = {
  crossOrigin: true,
  keepBuffer: 4,
  maxNativeZoom: 18,
  maxZoom: 22,
  opacity: 0.78,
  updateInterval: 180,
  updateWhenIdle: true,
  updateWhenZooming: false
};

function createTileLayer(url, options = {}) {
  ensureLeafletTileDefaults();

  return L.tileLayer(url, {
    ...options,
    subdomains: options.subdomains ?? DEFAULT_TILE_SUBDOMAINS
  });
}

function ensureLeafletTileDefaults() {
  if (!L.TileLayer.prototype.options) {
    L.TileLayer.prototype.options = {};
  }

  if (!L.TileLayer.prototype.options.subdomains) {
    L.TileLayer.prototype.options.subdomains = DEFAULT_TILE_SUBDOMAINS;
  }
}

function hasValidPlotPolygon(feature) {
  const coordinates = feature?.geometry?.coordinates?.[0];
  return Array.isArray(coordinates) && coordinates.length >= MIN_PLOT_POLYGON_VERTICES;
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - 1);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

let leafletDrawPromise;

function loadLeafletDraw() {
  if (!leafletDrawPromise) {
    ensureLeafletTileDefaults();
    window.L = L;
    leafletDrawPromise = import("leaflet-draw").then(() => {
      if (!L.Control?.Draw || !L.Draw?.Event) {
        throw new Error("Leaflet Draw failed to initialize.");
      }
    });
  }

  return leafletDrawPromise;
}

export function MapView({
  activeRaster,
  activeLstRaster,
  onLstReady,
  onPolygonChange,
  onRasterReady
}) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const baseLayerRef = useRef(null);
  const plotLayerRef = useRef(null);
  const drawnLayerRef = useRef(null);
  const rasterLayersRef = useRef([]);
  const anomalyLayerRef = useRef(null);
  const compareSliderRef = useRef(null);
  const latestFeatureRef = useRef(null);
  const activeRasterRef = useRef(null);
  const activeLstRasterRef = useRef(null);

  const dates = useMemo(defaultDateRange, []);
  const [baseMap, setBaseMap] = useState("imagery");
  const [plots, setPlots] = useState(null);
  const [layerState, setLayerState] = useState({
    plots: true,
    ndvi: true,
    lst: true,
    anomalies: true
  });
  const [compareMode, setCompareMode] = useState(false);
  const [comparePosition, setComparePosition] = useState(50);
  const [status, setStatus] = useState("Loading plot boundaries.");
  const [isCreatingRaster, setIsCreatingRaster] = useState(false);
  const [anomalyFeatures, setAnomalyFeatures] = useState([]);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    activeRasterRef.current = activeRaster;
  }, [activeRaster]);

  useEffect(() => {
    activeLstRasterRef.current = activeLstRaster;
  }, [activeLstRaster]);

  useEffect(() => {
    let isCancelled = false;

    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    loadLeafletDraw()
      .then(() => {
        if (isCancelled || !mapElementRef.current || mapRef.current) {
          return;
        }

        const map = L.map(mapElementRef.current, {
          center: DEFAULT_CENTER,
          preferCanvas: true,
          renderer: L.canvas({ padding: 0.35 }),
          zoom: DEFAULT_ZOOM,
          zoomControl: false
        });

        map.createPane("plotPane").style.zIndex = 410;
        map.createPane("rasterPane").style.zIndex = 350;
        map.createPane("compareLeftPane").style.zIndex = 360;
        map.createPane("compareRightPane").style.zIndex = 361;
        map.createPane("anomalyPane").style.zIndex = 430;

        L.control.zoom({ position: "bottomright" }).addTo(map);

        drawnLayerRef.current = new L.FeatureGroup();
        map.addLayer(drawnLayerRef.current);

        const drawControl = new L.Control.Draw({
          draw: {
            circle: false,
            circlemarker: false,
            marker: false,
            polyline: false,
            rectangle: false,
            polygon: {
              allowIntersection: false,
              drawError: { color: "#b91c1c", message: "Plot boundaries cannot intersect." },
              shapeOptions: {
                color: "#f59e0b",
                fillColor: "#fef3c7",
                fillOpacity: 0.18,
                weight: 3
              }
            }
          },
          edit: {
            featureGroup: drawnLayerRef.current,
            remove: true
          }
        });

        map.addControl(drawControl);
        map.on(L.Draw.Event.CREATED, (event) => {
          drawnLayerRef.current.clearLayers();
          drawnLayerRef.current.addLayer(event.layer);
          const feature = event.layer.toGeoJSON();
          if (!hasValidPlotPolygon(feature)) {
            setStatus("Plot boundary needs at least three vertices.");
            return;
          }
          latestFeatureRef.current = feature;
          onPolygonChange(feature);
          setStatus("Plot boundary captured. Generate NDVI and LST rasters when ready.");
        });
        map.on(L.Draw.Event.EDITED, (event) => {
          event.layers.eachLayer((layer) => {
            const feature = layer.toGeoJSON();
            if (!hasValidPlotPolygon(feature)) {
              setStatus("Edited plot boundary needs at least three vertices.");
              return;
            }
            latestFeatureRef.current = feature;
            onPolygonChange(feature);
          });
        });
        map.on(L.Draw.Event.DELETED, () => {
          latestFeatureRef.current = null;
          onPolygonChange(null);
          setAnomalyFeatures([]);
          setStatus("Draw or select a plot boundary to inspect crop conditions.");
        });

        mapRef.current = map;
        setMapReady(true);
      })
      .catch((error) => {
        if (!isCancelled) {
          setStatus(error.message);
        }
      });

    return () => {
      isCancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      setMapReady(false);
    };
  }, [onPolygonChange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }

    if (baseLayerRef.current) {
      map.removeLayer(baseLayerRef.current);
    }

    const selected = BASEMAPS[baseMap];
    baseLayerRef.current = createTileLayer(selected.url, {
      attribution: selected.attribution,
      maxZoom: 22,
      subdomains: selected.subdomains
    }).addTo(map);
  }, [baseMap, mapReady]);

  useEffect(() => {
    let isMounted = true;

    fetchPlots()
      .then((data) => {
        if (!isMounted) {
          return;
        }
        setPlots(data);
        setStatus("Plot boundaries ready. Select a plot for unified inspection.");
      })
      .catch((error) => {
        if (isMounted) {
          setStatus(error.message);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !plots) {
      return;
    }

    if (plotLayerRef.current) {
      map.removeLayer(plotLayerRef.current);
      plotLayerRef.current = null;
    }

    if (!layerState.plots) {
      return;
    }

    plotLayerRef.current = L.geoJSON(plots, {
      pane: "plotPane",
      renderer: L.canvas({ padding: 0.4 }),
      style: {
        color: "#f8fafc",
        dashArray: "6 4",
        fillColor: "#10b981",
        fillOpacity: 0.08,
        lineCap: "round",
        weight: 2
      },
      onEachFeature: (feature, layer) => {
        layer.on("click", (event) => handlePlotClick(feature, event.latlng));
        layer.on("mouseover", () => layer.setStyle({ color: "#34d399", weight: 4 }));
        layer.on("mouseout", () => layer.setStyle({ color: "#f8fafc", weight: 2 }));
      }
    }).addTo(map);

    const bounds = plotLayerRef.current.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.28), { animate: false });
    }
  }, [layerState.plots, mapReady, plots]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }

    rasterLayersRef.current.forEach((layer) => map.removeLayer(layer));
    rasterLayersRef.current = [];

    if (compareMode && activeRaster?.tile_url && activeLstRaster?.tile_url) {
      const ndvi = createTileLayer(activeRaster.tile_url, {
        ...TILE_OPTIONS,
        pane: "compareLeftPane"
      }).addTo(map);
      const lst = createTileLayer(activeLstRaster.tile_url, {
        ...TILE_OPTIONS,
        pane: "compareRightPane"
      }).addTo(map);

      rasterLayersRef.current = [ndvi, lst];
      updateCompareClip(comparePosition);
      fitRasterBounds(activeRaster.bounds);
      return;
    }

    resetCompareClip();

    if (layerState.ndvi && activeRaster?.tile_url) {
      const ndvi = createTileLayer(activeRaster.tile_url, {
        ...TILE_OPTIONS,
        pane: "rasterPane"
      }).addTo(map);
      rasterLayersRef.current.push(ndvi);
      fitRasterBounds(activeRaster.bounds);
    }

    if (layerState.lst && activeLstRaster?.tile_url) {
      const lst = createTileLayer(activeLstRaster.tile_url, {
        ...TILE_OPTIONS,
        opacity: layerState.ndvi && activeRaster?.tile_url ? 0.52 : 0.78,
        pane: "rasterPane"
      }).addTo(map);
      rasterLayersRef.current.push(lst);
      fitRasterBounds(activeLstRaster.bounds);
    }
  }, [activeLstRaster, activeRaster, compareMode, layerState.lst, layerState.ndvi, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }

    if (anomalyLayerRef.current) {
      map.removeLayer(anomalyLayerRef.current);
      anomalyLayerRef.current = null;
    }

    if (!layerState.anomalies || !anomalyFeatures.length) {
      return;
    }

    anomalyLayerRef.current = L.geoJSON(
      { type: "FeatureCollection", features: anomalyFeatures },
      {
        pane: "anomalyPane",
        style: {
          className: "ml-anomaly-boundary",
          color: "#dc2626",
          fillColor: "#ef4444",
          fillOpacity: 0.2,
          weight: 4
        }
      }
    ).addTo(map);
  }, [anomalyFeatures, layerState.anomalies, mapReady]);

  useEffect(() => {
    updateCompareClip(comparePosition);
  }, [comparePosition]);

  function fitRasterBounds(bounds) {
    if (!bounds?.length || !mapRef.current) {
      return;
    }

    const leafletBounds = L.latLngBounds(
      [bounds[1], bounds[0]],
      [bounds[3], bounds[2]]
    );
    if (leafletBounds.isValid()) {
      mapRef.current.fitBounds(leafletBounds.pad(0.08), { animate: false });
    }
  }

  function resetCompareClip() {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    map.getPane("compareLeftPane").style.clipPath = "";
    map.getPane("compareRightPane").style.clipPath = "";
  }

  function updateCompareClip(position) {
    const map = mapRef.current;
    if (!map || !compareMode) {
      return;
    }

    map.getPane("compareLeftPane").style.clipPath = `inset(0 ${100 - position}% 0 0)`;
    map.getPane("compareRightPane").style.clipPath = `inset(0 0 0 ${position}%)`;
  }

  function toggleLayer(layerKey) {
    setLayerState((current) => ({
      ...current,
      [layerKey]: !current[layerKey]
    }));
  }

  async function createRasterPair() {
    const feature = latestFeatureRef.current;
    if (!feature) {
      setStatus("Select or draw a plot before generating satellite overlays.");
      return;
    }

    setIsCreatingRaster(true);
    setStatus("Requesting Sentinel-2 NDVI and Landsat LST rasters.");
    try {
      const [ndvi, lst] = await Promise.all([
        createNdviRaster({ polygon: feature }),
        createLstRaster({ polygon: feature })
      ]);
      onRasterReady(ndvi);
      onLstReady(lst);
      setStatus("NDVI and LST overlays are ready for pixel-level inspection.");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsCreatingRaster(false);
    }
  }

  async function scanSelectedAnomaly() {
    const feature = latestFeatureRef.current;
    if (!feature) {
      setStatus("Select or draw a plot before running the anomaly overlay.");
      return;
    }

    setStatus("Scoring selected plot with the Isolation Forest model.");
    try {
      const result = await scoreCropAnomaly({
        polygon: feature,
        startDate: dates.startDate,
        endDate: dates.endDate
      });
      setAnomalyFeatures(result.is_anomaly ? [withAnomalyProperties(feature, result)] : []);
      setStatus(
        result.is_anomaly
          ? "Semi-abrupt statistical anomaly highlighted on the map."
          : "Selected plot is currently within learned crop behavior."
      );
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function handlePlotClick(feature, latlng) {
    const ndviRaster = activeRasterRef.current;
    const lstRaster = activeLstRasterRef.current;

    latestFeatureRef.current = feature;
    onPolygonChange(feature);

    const popup = L.popup({ maxWidth: 360 })
      .setLatLng(latlng)
      .setContent(popupShell("Loading unified spatial inspector."))
      .openOn(mapRef.current);

    try {
      const [ndviPixel, lstPixel, risk] = await Promise.all([
        ndviRaster?.session_id
          ? inspectNdviPixel({
              sessionId: ndviRaster.session_id,
              longitude: latlng.lng,
              latitude: latlng.lat
            }).catch(() => null)
          : Promise.resolve(null),
        lstRaster?.session_id
          ? inspectLstPixel({
              sessionId: lstRaster.session_id,
              longitude: latlng.lng,
              latitude: latlng.lat
            }).catch(() => null)
          : Promise.resolve(null),
        scoreCropAnomaly({
          polygon: feature,
          startDate: dates.startDate,
          endDate: dates.endDate
        }).catch(() => null)
      ]);

      if (risk?.is_anomaly) {
        setAnomalyFeatures((current) => mergeAnomalyFeature(current, feature, risk));
      }

      popup.setContent(renderInspector({ feature, latlng, lstPixel, ndviPixel, risk }));
    } catch (error) {
      popup.setContent(popupShell(error.message));
    }
  }

  return (
    <div className="relative h-full overflow-hidden bg-slate-900">
      <div ref={mapElementRef} className="h-full w-full" />

      <section className="absolute left-3 right-3 top-3 z-[1000] max-h-[calc(100%-7rem)] overflow-y-auto rounded border border-white/20 bg-white/95 p-4 shadow-xl backdrop-blur sm:left-4 sm:right-auto sm:top-4 sm:w-80">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
              GIS Map View
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">Satellite Layers</h2>
          </div>
          <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
            10m / 30m
          </span>
        </div>

        <div className="mt-4 space-y-4 text-sm">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Base map
            </p>
            <div className="grid grid-cols-1 gap-2">
              {Object.entries(BASEMAPS).map(([key, value]) => (
                <button
                  className={[
                    "rounded border px-3 py-2 text-left transition",
                    baseMap === key
                      ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  ].join(" ")}
                  key={key}
                  onClick={() => setBaseMap(key)}
                  type="button"
                >
                  {value.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Data layers
            </p>
            <div className="space-y-2">
              <LayerToggle
                active={layerState.plots}
                label="Plot Boundaries"
                onClick={() => toggleLayer("plots")}
              />
              <LayerToggle
                active={layerState.ndvi}
                label="NDVI - Sentinel-2"
                onClick={() => toggleLayer("ndvi")}
              />
              <LayerToggle
                active={layerState.lst}
                label="LST - Landsat 8/9"
                onClick={() => toggleLayer("lst")}
              />
              <LayerToggle
                active={layerState.anomalies}
                label="ML Anomaly Heatmap"
                onClick={() => toggleLayer("anomalies")}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              className="rounded bg-slate-900 px-3 py-2 font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={isCreatingRaster}
              onClick={createRasterPair}
              type="button"
            >
              {isCreatingRaster ? "Creating" : "Generate Rasters"}
            </button>
            <button
              className="rounded bg-red-600 px-3 py-2 font-medium text-white hover:bg-red-700"
              onClick={scanSelectedAnomaly}
              type="button"
            >
              Score Risk
            </button>
          </div>

          <label className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-3 py-2">
            <span>
              <span className="block font-medium text-slate-800">Compare Mode</span>
              <span className="text-xs text-slate-500">NDVI left, LST right</span>
            </span>
            <input
              checked={compareMode}
              className="h-4 w-4 accent-emerald-600"
              disabled={!activeRaster?.tile_url || !activeLstRaster?.tile_url}
              onChange={(event) => setCompareMode(event.target.checked)}
              type="checkbox"
            />
          </label>
        </div>
      </section>

      {compareMode ? (
        <div className="pointer-events-none absolute inset-y-0 left-0 right-0 z-[950]">
          <div
            className="absolute bottom-0 top-0 w-0.5 bg-white shadow"
            style={{ left: `${comparePosition}%` }}
          />
          <input
            aria-label="Swipe between NDVI and LST"
            className="pointer-events-auto absolute left-4 right-4 top-1/2 h-2 -translate-y-1/2 cursor-ew-resize accent-white"
            max="100"
            min="0"
            onChange={(event) => setComparePosition(Number(event.target.value))}
            ref={compareSliderRef}
            type="range"
            value={comparePosition}
          />
          <div className="absolute bottom-6 left-6 rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white">
            NDVI crop health
          </div>
          <div className="absolute bottom-6 right-6 rounded bg-red-700 px-3 py-1 text-xs font-semibold text-white">
            LST water stress
          </div>
        </div>
      ) : null}

      <div className="absolute bottom-3 left-3 right-3 z-[1000] rounded border border-white/20 bg-slate-950/85 px-4 py-3 text-sm text-white shadow-lg sm:bottom-4 sm:left-4 sm:right-auto sm:max-w-xl">
        {status}
      </div>

      <Legend />
    </div>
  );
}

function LayerToggle({ active, label, onClick }) {
  return (
    <button
      className="flex w-full items-center justify-between rounded border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50"
      onClick={onClick}
      type="button"
    >
      <span className="font-medium text-slate-700">{label}</span>
      <span
        className={[
          "h-5 w-9 rounded-full p-0.5 transition",
          active ? "bg-emerald-600" : "bg-slate-300"
        ].join(" ")}
      >
        <span
          className={[
            "block h-4 w-4 rounded-full bg-white transition",
            active ? "translate-x-4" : ""
          ].join(" ")}
        />
      </span>
    </button>
  );
}

function Legend() {
  return (
    <section className="absolute bottom-4 right-4 z-[1000] w-72 rounded border border-white/20 bg-white/95 p-4 text-xs shadow-xl">
      <p className="font-semibold text-slate-900">Spectral Ramps</p>
      <div className="mt-3">
        <div className="h-3 rounded bg-gradient-to-r from-red-700 via-yellow-300 to-emerald-600" />
        <div className="mt-1 flex justify-between text-slate-500">
          <span>Low NDVI</span>
          <span>High vigor</span>
        </div>
      </div>
      <div className="mt-3">
        <div className="h-3 rounded bg-gradient-to-r from-blue-500 via-yellow-400 via-red-500 to-red-950" />
        <div className="mt-1 flex justify-between text-slate-500">
          <span>Cool canopy</span>
          <span>Thermal stress</span>
        </div>
      </div>
      <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
        Semi-abrupt iForest anomalies use red pulsing plot outlines.
      </div>
    </section>
  );
}

function popupShell(message) {
  return `
    <div class="min-w-72 rounded bg-white p-3 text-sm text-slate-700">
      <p class="font-semibold text-slate-900">Spatial Inspector</p>
      <p class="mt-2">${escapeHtml(message)}</p>
    </div>
  `;
}

function renderInspector({ feature, latlng, lstPixel, ndviPixel, risk }) {
  const properties = feature.properties ?? {};
  const areaHa = Number(properties.area_ha ?? 0);
  const areaRai = areaHa * RAI_PER_HECTARE;
  const latestNdvi = risk?.latest_features?.ndvi ?? ndviPixel?.ndvi;
  const latestLst = risk?.latest_features?.lst_celsius ?? lstPixel?.lst_celsius;
  const riskLabel = risk
    ? risk.is_anomaly
      ? `Pest/Disease Risk: HIGH - ${risk.label}`
      : `Pest/Disease Risk: NORMAL - ${risk.label}`
    : "Risk not available";

  return `
    <div class="min-w-80 rounded bg-white p-4 text-sm text-slate-700">
      <div class="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <p class="text-xs font-semibold uppercase tracking-wide text-emerald-700">Spatial Inspector</p>
          <h3 class="mt-1 text-base font-semibold text-slate-900">${escapeHtml(
            properties.name ?? "Agricultural Plot"
          )}</h3>
        </div>
        <span class="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">${escapeHtml(
          properties.id ?? "plot"
        )}</span>
      </div>
      <dl class="mt-3 grid grid-cols-2 gap-2">
        <div class="rounded bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">Area</dt>
          <dd class="mt-1 font-semibold">${formatNumber(areaHa, 2)} ha / ${formatNumber(
            areaRai,
            2
          )} rai</dd>
        </div>
        <div class="rounded bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">Mean NDVI</dt>
          <dd class="mt-1 font-semibold">${formatNullable(latestNdvi, 3)}</dd>
        </div>
        <div class="rounded bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">LST</dt>
          <dd class="mt-1 font-semibold">${formatNullable(latestLst, 1)} C</dd>
        </div>
        <div class="rounded bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">Clicked pixel</dt>
          <dd class="mt-1 font-semibold">${formatNumber(latlng.lat, 5)}, ${formatNumber(
            latlng.lng,
            5
          )}</dd>
        </div>
      </dl>
      <div class="mt-3 rounded ${
        risk?.is_anomaly ? "bg-red-700 text-white" : "bg-emerald-100 text-emerald-800"
      } px-3 py-2 font-semibold">
        ${escapeHtml(riskLabel)}
      </div>
      ${
        risk
          ? `<p class="mt-2 text-xs text-slate-500">iForest anomaly score: ${formatNumber(
              risk.anomaly_score,
              4
            )}</p>`
          : ""
      }
    </div>
  `;
}

function mergeAnomalyFeature(current, feature, risk) {
  const next = withAnomalyProperties(feature, risk);
  const nextId = next.properties?.id;
  const withoutExisting = current.filter((item) => item.properties?.id !== nextId);
  return [...withoutExisting, next];
}

function withAnomalyProperties(feature, risk) {
  return {
    ...feature,
    properties: {
      ...(feature.properties ?? {}),
      anomaly_score: risk.anomaly_score,
      anomaly_status: risk.status,
      anomaly_label: risk.label
    }
  };
}

function formatNullable(value, digits) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "N/A";
}

function formatNumber(value, digits) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "0.00";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
