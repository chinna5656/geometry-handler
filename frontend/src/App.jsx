import { useState } from "react";

import { AnalyticsPanel } from "./components/AnalyticsPanel.jsx";
import { AlertPanel } from "./components/AlertPanel.jsx";
import { MapView } from "./components/MapView.jsx";

export default function App() {
  const [activeRaster, setActiveRaster] = useState(null);
  const [activeLstRaster, setActiveLstRaster] = useState(null);
  const [drawnPolygon, setDrawnPolygon] = useState(null);

  return (
    <main className="flex h-full bg-slate-50 text-slate-900">
      <aside className="z-10 w-96 border-r border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">
          Crop Health Monitor
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Sentinel-2 NDVI</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Draw a field boundary, generate an NDVI overlay from Sentinel-2 B08 and
          B04, then click the raster to inspect pixel-level crop vigor.
        </p>

        <div className="mt-6 rounded border border-slate-200 bg-slate-50 p-4 text-sm">
          <p className="font-medium">Active NDVI raster</p>
          <p className="mt-2 break-all text-slate-600">
            {activeRaster?.scene?.id ?? "Draw a plot boundary to create an overlay."}
          </p>
          {activeRaster ? (
            <p className="mt-3 text-slate-600">
              Cloud cover: {activeRaster.scene.cloud_cover.toFixed(1)}%
            </p>
          ) : null}
        </div>

        <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-4 text-sm">
          <p className="font-medium">Active LST raster</p>
          <p className="mt-2 break-all text-slate-600">
            {activeLstRaster?.scene?.id ?? "Generate a thermal overlay to inspect crop fever."}
          </p>
          {activeLstRaster ? (
            <p className="mt-3 text-slate-600">
              Landsat cloud cover: {activeLstRaster.scene.cloud_cover.toFixed(1)}%
            </p>
          ) : null}
        </div>

        <AnalyticsPanel polygon={drawnPolygon} />
        <AlertPanel polygon={drawnPolygon} />
      </aside>

      <section className="min-w-0 flex-1">
        <MapView
          activeRaster={activeRaster}
          activeLstRaster={activeLstRaster}
          onPolygonChange={setDrawnPolygon}
          onLstReady={setActiveLstRaster}
          onRasterReady={setActiveRaster}
        />
      </section>
    </main>
  );
}
