# Precision Agriculture Geospatial App

Starter architecture for a plot-level crop health application using Sentinel-2 Surface Reflectance and NDVI overlays.

## Stack

- Frontend: React, Vite, Tailwind CSS, Leaflet.js, Leaflet.draw
- Backend: FastAPI, rasterio, geopandas, shapely, pyproj
- Data source: Microsoft Planetary Computer STAC API for Sentinel-2 L2A

Leaflet is used for the Esri World Imagery map interface because it provides stable raster basemap rendering, polygon drawing tools, and tile overlays without relying on WebGL.

## Project Layout

```text
geometry-handler/
  backend/
    app/
      api/
      core/
      models/
      services/
      main.py
    pyproject.toml
    .env.example
  frontend/
    src/
      components/
      lib/
      App.jsx
      main.jsx
      index.css
    package.json
    vite.config.js
    tailwind.config.js
    postcss.config.js
    .env.example
```

## Quick Start

Backend:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -e .
uvicorn app.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Create `.env` files from the examples before running in a real environment.

## Interactive NDVI Workflow

1. Draw a plot polygon in the Leaflet Esri World Imagery map interface.
2. The frontend posts that GeoJSON feature to `POST /api/v1/ndvi/raster`.
3. The backend searches Microsoft Planetary Computer for the latest low-cloud Sentinel-2 L2A scene, reads `B08` and `B04`, and computes:

```text
NDVI = (NIR - Red) / (NIR + Red)
```

4. The response returns a polygon-scoped raster tile URL. The frontend adds it as a color-ramped Leaflet raster tile layer.
5. Clicking inside the overlay calls `GET /api/v1/ndvi/raster/{session_id}/inspect?lon=...&lat=...` and displays the exact coordinate plus sampled pixel NDVI.

For compatibility with the requested route shape, the NDVI router is also mounted under `/api`, so `POST /api/ndvi/raster` is available in addition to the versioned endpoint.

## Historical Growth Analytics

The dashboard posts drawn plot boundaries to `POST /api/v1/ndvi/time-series` with `start_date` and `end_date`. The backend searches Sentinel-2 L2A scenes for the period, filters by cloud cover, computes polygon mean NDVI per scene date, averages duplicate same-day observations, and returns chronological points:

```json
{
  "points": [
    { "date": "2026-03-01", "mean_ndvi": 0.25 },
    { "date": "2026-04-15", "mean_ndvi": 0.58 }
  ]
}
```

The same endpoint is also available at `POST /api/ndvi/time-series`.

## Land Surface Temperature

The thermal workflow posts a drawn plot polygon to `POST /api/v1/lst/raster` or `POST /api/lst/raster`. The backend searches Microsoft Planetary Computer Landsat 8/9 Collection 2 Level-2 scenes, selects the latest low-cloud surface temperature asset, applies scale and offset metadata, converts Kelvin to Celsius, masks cloudy pixels with `QA_PIXEL`, and serves a polygon-clipped raster tile layer:

```text
GET /api/v1/lst/raster/{session_id}/tiles/{z}/{x}/{y}.png
GET /api/v1/lst/raster/{session_id}/inspect?lon=...&lat=...
```

The frontend can display the 30 m Landsat thermal raster as a cool-blue to dark-red Leaflet overlay, and the click inspector reports both NDVI and LST when both sessions are active.

## Crop Anomaly Early Warning

`POST /api/v1/anomaly/score` and `POST /api/anomaly/score` train a plot-specific Isolation Forest from historical fused features:

- Sentinel-2 mean NDVI
- Landsat 8/9 mean LST in Celsius
- CHIRPS rolling cumulative rainfall

The service aligns multi-sensor observations by date with pandas, validates the plot with GeoPandas, scales and imputes features, trains `sklearn.ensemble.IsolationForest`, and scores the latest observation. Negative Isolation Forest decision scores are returned as `Semi-Abrupt Statistical Anomaly`, indicating elevated pest or disease outbreak risk.
"# geometry-handler" 
