from datetime import date
from io import BytesIO
from uuid import uuid4

import matplotlib
import mercantile
import numpy as np
import planetary_computer
import rasterio
from pyproj import Transformer
from pystac_client import Client
from rio_tiler.io import Reader
from shapely import contains_xy
from shapely.geometry import Point, Polygon, shape
from shapely.ops import transform

from app.core.config import settings

matplotlib.use("Agg")
from matplotlib import pyplot as plt


class LstService:
    collection = "landsat-c2-l2"

    def __init__(self) -> None:
        self.client = Client.open(str(settings.planetary_computer_stac_url))
        self._session_cache: dict[str, dict] = {}

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
        scene = self._find_latest_scene(
            bbox=bbox,
            start_date=start_date,
            end_date=end_date,
            max_cloud_cover=max_cloud_cover,
        )
        if scene is None:
            raise LookupError("No low-cloud Landsat 8/9 L2 surface temperature scene found.")

        session_id = uuid4().hex
        transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
        geometry_3857 = transform(transformer.transform, geometry)

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

    def render_session_tile(self, session_id: str, z: int, x: int, y: int) -> bytes:
        session = self._get_session(session_id)
        scene = session["scene"]
        lst_raw = self._read_asset_tile(scene["lst_href"], z, x, y).astype("float32")
        lst_celsius = self._to_celsius(lst_raw, scene["scale"], scene["offset"])

        mask = np.where(np.isfinite(lst_celsius), 255, 0).astype("uint8")
        if scene.get("qa_href"):
            qa = self._read_asset_tile(
                scene["qa_href"],
                z,
                x,
                y,
                resampling_method="nearest",
            ).astype("uint16")
            mask = np.minimum(mask, self._qa_clear_mask(qa))

        mask = np.minimum(
            mask,
            self._tile_polygon_mask(session["polygon_3857"], z, x, y),
        )

        normalized = np.clip((lst_celsius - 15.0) / 35.0, 0.0, 1.0)
        rgba = plt.get_cmap("turbo")(normalized, bytes=True)
        rgba[..., 3] = mask

        output = BytesIO()
        plt.imsave(output, rgba, format="png")
        return output.getvalue()

    def inspect_pixel(self, session_id: str, lon: float, lat: float) -> dict:
        session = self._get_session(session_id)
        point = Point(lon, lat)
        if not session["polygon"].contains(point):
            raise ValueError("Point is outside the active LST polygon.")

        scene = session["scene"]
        if scene.get("qa_href"):
            qa_value = self._sample_asset(scene["qa_href"], lon, lat)
            if self._qa_clear_mask(np.array([[qa_value]], dtype="uint16"))[0, 0] == 0:
                raise LookupError("Landsat pixel is cloud, shadow, cirrus, or fill masked.")

        raw_value = self._sample_asset(scene["lst_href"], lon, lat)
        if raw_value <= 0:
            raise LookupError("No valid Landsat surface temperature pixel found.")

        lst_celsius = self._to_celsius(raw_value, scene["scale"], scene["offset"])
        return {
            "longitude": lon,
            "latitude": lat,
            "lst_celsius": round(float(lst_celsius), 2),
            "class_name": self._classify_lst(float(lst_celsius)),
        }

    def _find_latest_scene(
        self,
        bbox: list[float],
        start_date: date,
        end_date: date,
        max_cloud_cover: float,
    ) -> dict | None:
        search = self.client.search(
            collections=[self.collection],
            bbox=bbox,
            datetime=f"{start_date.isoformat()}/{end_date.isoformat()}",
            query={
                "eo:cloud_cover": {"lt": max_cloud_cover},
                "platform": {"in": ["landsat-8", "landsat-9"]},
            },
            sortby=[{"field": "properties.datetime", "direction": "desc"}],
            max_items=25,
        )

        for item in search.items():
            signed = planetary_computer.sign(item)
            lst_asset = signed.assets.get("lwir11") or signed.assets.get("ST_B10")
            if lst_asset is None:
                continue

            qa_asset = signed.assets.get("qa_pixel") or signed.assets.get("QA_PIXEL")
            scale, offset = self._asset_scale_offset(lst_asset)
            return {
                "id": signed.id,
                "datetime": signed.datetime,
                "cloud_cover": signed.properties.get("eo:cloud_cover", 0.0),
                "bbox": signed.bbox,
                "lst_href": lst_asset.href,
                "qa_href": qa_asset.href if qa_asset else None,
                "scale": scale,
                "offset": offset,
            }

        return None

    @staticmethod
    def _read_asset_tile(
        href: str,
        z: int,
        x: int,
        y: int,
        resampling_method: str = "bilinear",
    ) -> np.ndarray:
        with Reader(href) as cog:
            tile = cog.tile(x, y, z, tilesize=256, resampling_method=resampling_method)
        return tile.data[0]

    @staticmethod
    def _sample_asset(href: str, lon: float, lat: float) -> float:
        with rasterio.open(href) as src:
            transformer = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
            x, y = transformer.transform(lon, lat)
            value = next(src.sample([(x, y)]))[0]
        return float(value)

    @staticmethod
    def _to_celsius(value: np.ndarray | float, scale: float, offset: float) -> np.ndarray | float:
        return (value * scale + offset) - 273.15

    @staticmethod
    def _qa_clear_mask(qa: np.ndarray) -> np.ndarray:
        fill = (qa & (1 << 0)) != 0
        dilated_cloud = (qa & (1 << 1)) != 0
        cirrus = (qa & (1 << 2)) != 0
        cloud = (qa & (1 << 3)) != 0
        cloud_shadow = (qa & (1 << 4)) != 0
        snow = (qa & (1 << 5)) != 0
        clear = ~(fill | dilated_cloud | cirrus | cloud | cloud_shadow | snow)
        return np.where(clear, 255, 0).astype("uint8")

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
            raise ValueError("Only GeoJSON Polygon geometries are supported for LST rasters.")
        if geometry.is_empty or not geometry.is_valid:
            raise ValueError("Polygon geometry is empty or invalid.")
        return geometry

    @staticmethod
    def _asset_scale_offset(asset) -> tuple[float, float]:
        bands = asset.extra_fields.get("raster:bands", [])
        if bands:
            return (
                float(bands[0].get("scale", 0.00341802)),
                float(bands[0].get("offset", 149.0)),
            )
        return 0.00341802, 149.0

    @staticmethod
    def _classify_lst(lst_celsius: float) -> str:
        if lst_celsius < 28:
            return "Cool canopy / low water stress"
        if lst_celsius < 34:
            return "Moderate crop temperature"
        if lst_celsius < 38:
            return "Elevated water stress"
        return "High Water Stress Detected"

    def _get_session(self, session_id: str) -> dict:
        session = self._session_cache.get(session_id)
        if session is None:
            raise LookupError("LST raster session was not found or has expired.")
        return session
