from datetime import date
from io import BytesIO
from uuid import uuid4

import matplotlib
import mercantile
import numpy as np
import rasterio
from rasterio.mask import mask
from pyproj import Transformer
from rio_tiler.io import Reader
from shapely import contains_xy
from shapely.geometry import Point, Polygon, shape
from shapely.ops import transform

from app.services.stac_service import SentinelStacService

matplotlib.use("Agg")
from matplotlib import pyplot as plt


class NdviService:
    def __init__(self) -> None:
        self.stac = SentinelStacService()
        self._scene_cache: dict[str, dict] = {}
        self._session_cache: dict[str, dict] = {}

    def search_scenes(
        self,
        bbox: str,
        start_date: date,
        end_date: date,
        max_cloud_cover: float,
    ) -> list[dict]:
        parsed_bbox = self._parse_bbox(bbox)
        scenes = self.stac.search(
            bbox=parsed_bbox,
            start_date=start_date,
            end_date=end_date,
            max_cloud_cover=max_cloud_cover,
        )
        self._scene_cache.update({scene["id"]: scene for scene in scenes})
        return scenes

    def create_raster_session(
        self,
        polygon: dict,
        days_back: int,
        max_cloud_cover: float,
    ) -> dict:
        geometry = self._extract_polygon_geometry(polygon)
        bbox = list(geometry.bounds)
        end_date = date.today()
        start_date = date.fromordinal(end_date.toordinal() - days_back)

        scenes = self.stac.search(
            bbox=bbox,
            start_date=start_date,
            end_date=end_date,
            max_cloud_cover=max_cloud_cover,
            limit=1,
        )
        if not scenes:
            raise LookupError("No cloud-free Sentinel-2 L2A scenes found for the polygon.")

        scene = scenes[0]
        session_id = uuid4().hex
        transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
        geometry_3857 = transform(transformer.transform, geometry)

        self._scene_cache[scene["id"]] = scene
        self._session_cache[session_id] = {
            "scene": scene,
            "polygon": geometry,
            "polygon_3857": geometry_3857,
            "bounds": bbox,
        }

        return {
            "session_id": session_id,
            "scene": scene,
            "bounds": bbox,
        }

    def render_ndvi_tile(self, scene_id: str, z: int, x: int, y: int) -> bytes:
        scene = self._scene_cache.get(scene_id)
        if scene is None:
            raise LookupError(
                "Scene is not in the in-memory cache. Search scenes before requesting tiles."
            )

        return self._render_tile(scene=scene, z=z, x=x, y=y)

    def render_session_tile(self, session_id: str, z: int, x: int, y: int) -> bytes:
        session = self._get_session(session_id)
        return self._render_tile(
            scene=session["scene"],
            z=z,
            x=x,
            y=y,
            polygon_3857=session["polygon_3857"],
        )

    def inspect_pixel(self, session_id: str, lon: float, lat: float) -> dict:
        session = self._get_session(session_id)
        point = Point(lon, lat)
        if not session["polygon"].contains(point):
            raise ValueError("Point is outside the active NDVI polygon.")

        scene = session["scene"]
        red = self._sample_asset(scene["red_href"], lon, lat)
        nir = self._sample_asset(scene["nir_href"], lon, lat)
        if red <= 0 or nir <= 0 or red + nir == 0:
            raise LookupError("No valid Sentinel-2 pixel data found at this coordinate.")

        ndvi = float((nir - red) / (nir + red))
        return {
            "longitude": lon,
            "latitude": lat,
            "ndvi": round(ndvi, 4),
            "class_name": self._classify_ndvi(ndvi),
        }

    def calculate_time_series(
        self,
        polygon: dict,
        start_date: date,
        end_date: date,
        max_cloud_cover: float,
    ) -> list[dict]:
        if start_date > end_date:
            raise ValueError("start_date must be before or equal to end_date.")

        geometry = self._extract_polygon_geometry(polygon)
        scenes = self.stac.search(
            bbox=list(geometry.bounds),
            start_date=start_date,
            end_date=end_date,
            max_cloud_cover=max_cloud_cover,
            limit=100,
        )

        daily_values: dict[date, list[float]] = {}
        for scene in scenes:
            mean_ndvi = self._mean_ndvi_for_polygon(
                red_href=scene["red_href"],
                nir_href=scene["nir_href"],
                polygon=geometry,
            )
            if mean_ndvi is None:
                continue

            scene_date = scene["datetime"].date()
            daily_values.setdefault(scene_date, []).append(mean_ndvi)

        return [
            {
                "date": scene_date,
                "mean_ndvi": round(float(np.mean(values)), 4),
            }
            for scene_date, values in sorted(daily_values.items())
        ]

    def _render_tile(
        self,
        scene: dict,
        z: int,
        x: int,
        y: int,
        polygon_3857: Polygon | None = None,
    ) -> bytes:
        red_tile = self._read_asset_tile(scene["red_href"], z, x, y)
        nir_tile = self._read_asset_tile(scene["nir_href"], z, x, y)

        red = red_tile.astype("float32")
        nir = nir_tile.astype("float32")
        ndvi = np.divide(nir - red, nir + red, out=np.zeros_like(nir), where=(nir + red) != 0)
        ndvi = np.clip(ndvi, -1.0, 1.0)

        mask = np.where((red <= 0) | (nir <= 0), 0, 255).astype("uint8")
        if polygon_3857 is not None:
            mask = np.minimum(mask, self._tile_polygon_mask(polygon_3857, z, x, y))

        normalized = (ndvi + 1.0) / 2.0
        rgba = plt.get_cmap("RdYlGn")(normalized, bytes=True)
        rgba[..., 3] = mask

        output = BytesIO()
        plt.imsave(output, rgba, format="png")
        return output.getvalue()

    @staticmethod
    def _read_asset_tile(href: str, z: int, x: int, y: int) -> np.ndarray:
        with Reader(href) as cog:
            tile = cog.tile(x, y, z, tilesize=256, resampling_method="bilinear")
        return tile.data[0]

    @staticmethod
    def _sample_asset(href: str, lon: float, lat: float) -> float:
        with rasterio.open(href) as src:
            transformer = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
            x, y = transformer.transform(lon, lat)
            value = next(src.sample([(x, y)]))[0]
        return float(value)

    @staticmethod
    def _mean_ndvi_for_polygon(red_href: str, nir_href: str, polygon: Polygon) -> float | None:
        with rasterio.open(red_href) as red_src, rasterio.open(nir_href) as nir_src:
            transformer = Transformer.from_crs("EPSG:4326", red_src.crs, always_xy=True)
            projected_polygon = transform(transformer.transform, polygon)
            shapes = [projected_polygon.__geo_interface__]

            red_image, _ = mask(red_src, shapes, crop=True, filled=False)
            nir_image, _ = mask(nir_src, shapes, crop=True, filled=False)

        red = red_image[0].astype("float32")
        nir = nir_image[0].astype("float32")
        invalid = np.ma.getmaskarray(red) | np.ma.getmaskarray(nir) | (red <= 0) | (nir <= 0)
        ndvi = np.ma.array(
            np.divide(nir - red, nir + red, out=np.zeros_like(nir), where=(nir + red) != 0),
            mask=invalid,
        )

        if ndvi.count() == 0:
            return None

        return float(ndvi.mean())

    @staticmethod
    def _tile_polygon_mask(polygon_3857: Polygon, z: int, x: int, y: int) -> np.ndarray:
        bounds = mercantile.xy_bounds(x, y, z)
        x_coords = np.linspace(bounds.left, bounds.right, 256, endpoint=False) + (
            bounds.right - bounds.left
        ) / 512
        y_coords = np.linspace(bounds.top, bounds.bottom, 256, endpoint=False) + (
            bounds.bottom - bounds.top
        ) / 512
        grid_x, grid_y = np.meshgrid(x_coords, y_coords)
        inside = contains_xy(polygon_3857, grid_x, grid_y)
        return np.where(inside, 255, 0).astype("uint8")

    @staticmethod
    def _extract_polygon_geometry(payload: dict) -> Polygon:
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump()

        geometry_payload = payload.get("geometry", payload)
        geometry = shape(geometry_payload)
        if geometry.geom_type != "Polygon":
            raise ValueError("Only GeoJSON Polygon geometries are supported for NDVI rasters.")
        if geometry.is_empty or not geometry.is_valid:
            raise ValueError("Polygon geometry is empty or invalid.")
        return geometry

    @staticmethod
    def _classify_ndvi(ndvi: float) -> str:
        if ndvi < 0.2:
            return "Bare soil or severely stressed"
        if ndvi < 0.4:
            return "Stressed vegetation"
        if ndvi < 0.6:
            return "Moderate crop vigor"
        return "Healthy dense vegetation"

    def _get_session(self, session_id: str) -> dict:
        session = self._session_cache.get(session_id)
        if session is None:
            raise LookupError("NDVI raster session was not found or has expired.")
        return session

    @staticmethod
    def _parse_bbox(bbox: str) -> list[float]:
        try:
            values = [float(value.strip()) for value in bbox.split(",")]
        except ValueError as exc:
            raise ValueError("bbox must contain four numeric comma-separated values") from exc

        if len(values) != 4:
            raise ValueError("bbox must be formatted as minLon,minLat,maxLon,maxLat")

        min_lon, min_lat, max_lon, max_lat = values
        if min_lon >= max_lon or min_lat >= max_lat:
            raise ValueError("bbox minimum coordinates must be less than maximum coordinates")

        return values
