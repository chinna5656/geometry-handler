const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api/v1";

export async function fetchPlots() {
  const response = await fetch(`${API_BASE_URL}/plots`);
  if (!response.ok) {
    throw new Error("Unable to load plot boundaries");
  }
  return response.json();
}

export async function searchNdviScenes({ bbox, startDate, endDate, maxCloudCover = 20 }) {
  const params = new URLSearchParams({
    bbox: bbox.join(","),
    start_date: startDate,
    end_date: endDate,
    max_cloud_cover: String(maxCloudCover)
  });

  const response = await fetch(`${API_BASE_URL}/ndvi/scenes?${params}`);
  if (!response.ok) {
    throw new Error("Unable to search Sentinel-2 scenes");
  }
  return response.json();
}

export function ndviTileUrl(sceneId) {
  return `${API_BASE_URL}/ndvi/tiles/${sceneId}/{z}/{x}/{y}.png`;
}

export async function createNdviRaster({ polygon, daysBack = 90, maxCloudCover = 20 }) {
  const response = await fetch(`${API_BASE_URL}/ndvi/raster`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      polygon,
      days_back: daysBack,
      max_cloud_cover: maxCloudCover
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail ?? "Unable to create NDVI raster");
  }

  return response.json();
}

export async function createLstRaster({ polygon, daysBack = 120, maxCloudCover = 30 }) {
  const response = await fetch(`${API_BASE_URL}/lst/raster`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      polygon,
      days_back: daysBack,
      max_cloud_cover: maxCloudCover
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail ?? "Unable to create LST raster");
  }

  return response.json();
}

export async function inspectNdviPixel({ sessionId, longitude, latitude }) {
  const params = new URLSearchParams({
    lon: String(longitude),
    lat: String(latitude)
  });

  const response = await fetch(`${API_BASE_URL}/ndvi/raster/${sessionId}/inspect?${params}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail ?? "Unable to inspect NDVI pixel");
  }

  return response.json();
}

export async function inspectLstPixel({ sessionId, longitude, latitude }) {
  const params = new URLSearchParams({
    lon: String(longitude),
    lat: String(latitude)
  });

  const response = await fetch(`${API_BASE_URL}/lst/raster/${sessionId}/inspect?${params}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail ?? "Unable to inspect LST pixel");
  }

  return response.json();
}

export async function fetchNdviTimeSeries({
  polygon,
  startDate,
  endDate,
  maxCloudCover = 30
}) {
  const response = await fetch(`${API_BASE_URL}/ndvi/time-series`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      polygon,
      start_date: startDate,
      end_date: endDate,
      max_cloud_cover: maxCloudCover
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail ?? "Unable to load NDVI time series");
  }

  return response.json();
}

export async function scoreCropAnomaly({
  polygon,
  startDate,
  endDate,
  maxCloudCover = 35,
  rainfallWindowDays = 7,
  contamination = 0.12
}) {
  const response = await fetch(`${API_BASE_URL}/anomaly/score`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      polygon,
      start_date: startDate,
      end_date: endDate,
      max_cloud_cover: maxCloudCover,
      rainfall_window_days: rainfallWindowDays,
      contamination
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail ?? "Unable to score crop anomaly risk");
  }

  return response.json();
}
