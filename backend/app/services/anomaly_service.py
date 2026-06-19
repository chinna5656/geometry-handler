from datetime import date, timedelta

import geopandas as gpd
import numpy as np
import pandas as pd
import planetary_computer
import rasterio
from pyproj import Transformer
from pystac_client import Client
from rasterio.mask import mask
from shapely.geometry import Polygon, shape
from shapely.ops import transform
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from app.core.config import settings
from app.services.ndvi_service import NdviService


class CropAnomalyService:
    landsat_collection = "landsat-c2-l2"
    chirps_url = (
        "https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs/p05"
        "/{year}/chirps-v2.0.{date}.tif.gz"
    )

    def __init__(self) -> None:
        self.client = Client.open(str(settings.planetary_computer_stac_url))
        self.ndvi_service = NdviService()

    def score_plot(
        self,
        polygon: dict,
        start_date: date,
        end_date: date,
        max_cloud_cover: float,
        rainfall_window_days: int,
        contamination: float,
    ) -> dict:
        if start_date >= end_date:
            raise ValueError("start_date must be before end_date.")

        geometry = self._extract_polygon_geometry(polygon)
        frame = self.extract_feature_frame(
            geometry=geometry,
            start_date=start_date,
            end_date=end_date,
            max_cloud_cover=max_cloud_cover,
            rainfall_window_days=rainfall_window_days,
        )
        if len(frame) < 8:
            raise LookupError(
                "Not enough multi-sensor observations to train an Isolation Forest. "
                "Use a longer date range or relax cloud filtering."
            )

        model = Pipeline(
            steps=[
                ("imputer", SimpleImputer(strategy="median")),
                ("scaler", StandardScaler()),
                (
                    "iforest",
                    IsolationForest(
                        contamination=contamination,
                        n_estimators=300,
                        random_state=42,
                    ),
                ),
            ]
        )

        feature_columns = ["ndvi", "lst_celsius", "rainfall_mm"]
        x_train = frame[feature_columns]
        model.fit(x_train)

        latest = frame.iloc[[-1]]
        score = float(model.named_steps["iforest"].decision_function(
            model.named_steps["scaler"].transform(
                model.named_steps["imputer"].transform(latest[feature_columns])
            )
        )[0])
        is_anomaly = score < 0

        return {
            "status": "critical" if is_anomaly else "normal",
            "is_anomaly": is_anomaly,
            "anomaly_score": round(score, 5),
            "label": (
                "Semi-Abrupt Statistical Anomaly"
                if is_anomaly
                else "Normal phenology pattern"
            ),
            "latest_features": self._row_to_payload(latest.iloc[0]),
            "feature_history": [self._row_to_payload(row) for _, row in frame.iterrows()],
            "contributions": self._feature_contributions(frame, latest.iloc[0]),
        }

    def extract_feature_frame(
        self,
        geometry: Polygon,
        start_date: date,
        end_date: date,
        max_cloud_cover: float,
        rainfall_window_days: int,
    ) -> pd.DataFrame:
        ndvi = pd.DataFrame(
            self.ndvi_service.calculate_time_series(
                polygon=geometry.__geo_interface__,
                start_date=start_date,
                end_date=end_date,
                max_cloud_cover=max_cloud_cover,
            )
        ).rename(columns={"mean_ndvi": "ndvi"})
        lst = pd.DataFrame(
            self._calculate_lst_time_series(
                geometry=geometry,
                start_date=start_date,
                end_date=end_date,
                max_cloud_cover=max_cloud_cover,
            )
        )

        if ndvi.empty or lst.empty:
            return pd.DataFrame(columns=["date", "ndvi", "lst_celsius", "rainfall_mm"])

        ndvi["date"] = pd.to_datetime(ndvi["date"])
        lst["date"] = pd.to_datetime(lst["date"])
        fused = pd.merge_asof(
            ndvi.sort_values("date"),
            lst.sort_values("date"),
            on="date",
            direction="nearest",
            tolerance=pd.Timedelta(days=5),
        ).dropna(subset=["ndvi", "lst_celsius"])

        rainfall = self._calculate_chirps_rainfall(
            geometry=geometry,
            start_date=start_date - timedelta(days=rainfall_window_days),
            end_date=end_date,
        )
        if rainfall.empty:
            fused["rainfall_mm"] = np.nan
        else:
            rainfall["date"] = pd.to_datetime(rainfall["date"])
            rainfall = rainfall.sort_values("date")
            rainfall["rainfall_mm"] = rainfall["rainfall_mm"].rolling(
                window=rainfall_window_days,
                min_periods=1,
            ).sum()
            fused = pd.merge_asof(
                fused.sort_values("date"),
                rainfall[["date", "rainfall_mm"]],
                on="date",
                direction="backward",
                tolerance=pd.Timedelta(days=rainfall_window_days),
            )

        fused = fused.sort_values("date").dropna(subset=["ndvi", "lst_celsius"])
        if fused["rainfall_mm"].isna().all():
            fused["rainfall_mm"] = 0.0
        else:
            fused["rainfall_mm"] = fused["rainfall_mm"].fillna(fused["rainfall_mm"].median())
        return fused[["date", "ndvi", "lst_celsius", "rainfall_mm"]]

    def _calculate_lst_time_series(
        self,
        geometry: Polygon,
        start_date: date,
        end_date: date,
        max_cloud_cover: float,
    ) -> list[dict]:
        search = self.client.search(
            collections=[self.landsat_collection],
            bbox=list(geometry.bounds),
            datetime=f"{start_date.isoformat()}/{end_date.isoformat()}",
            query={
                "eo:cloud_cover": {"lt": max_cloud_cover},
                "platform": {"in": ["landsat-8", "landsat-9"]},
            },
            sortby=[{"field": "properties.datetime", "direction": "asc"}],
            max_items=100,
        )

        rows: list[dict] = []
        for item in search.items():
            signed = planetary_computer.sign(item)
            lst_asset = signed.assets.get("lwir11") or signed.assets.get("ST_B10")
            qa_asset = signed.assets.get("qa_pixel") or signed.assets.get("QA_PIXEL")
            if lst_asset is None:
                continue

            mean_lst = self._mean_lst_for_polygon(
                lst_href=lst_asset.href,
                qa_href=qa_asset.href if qa_asset else None,
                polygon=geometry,
                scale=self._asset_scale_offset(lst_asset)[0],
                offset=self._asset_scale_offset(lst_asset)[1],
            )
            if mean_lst is None:
                continue

            rows.append({"date": signed.datetime.date(), "lst_celsius": round(mean_lst, 3)})

        return (
            pd.DataFrame(rows)
            .groupby("date", as_index=False)["lst_celsius"]
            .mean()
            .to_dict("records")
            if rows
            else []
        )

    def _calculate_chirps_rainfall(
        self,
        geometry: Polygon,
        start_date: date,
        end_date: date,
    ) -> pd.DataFrame:
        rows: list[dict] = []
        for day in pd.date_range(start_date, end_date, freq="D"):
            day_date = day.date()
            href = self.chirps_url.format(
                year=day_date.year,
                date=day_date.strftime("%Y.%m.%d"),
            )
            try:
                rainfall = self._mean_raster_for_polygon(f"/vsigzip//vsicurl/{href}", geometry)
            except rasterio.errors.RasterioIOError:
                continue
            if rainfall is not None:
                rows.append({"date": day_date, "rainfall_mm": max(float(rainfall), 0.0)})

        return pd.DataFrame(rows)

    @staticmethod
    def _mean_lst_for_polygon(
        lst_href: str,
        qa_href: str | None,
        polygon: Polygon,
        scale: float,
        offset: float,
    ) -> float | None:
        with rasterio.open(lst_href) as lst_src:
            transformer = Transformer.from_crs("EPSG:4326", lst_src.crs, always_xy=True)
            projected_polygon = transform(transformer.transform, polygon)
            shapes = [projected_polygon.__geo_interface__]
            lst_image, _ = mask(lst_src, shapes, crop=True, filled=False)

        lst = lst_image[0].astype("float32")
        invalid = np.ma.getmaskarray(lst) | (lst <= 0)

        if qa_href:
            with rasterio.open(qa_href) as qa_src:
                qa_image, _ = mask(qa_src, shapes, crop=True, filled=False)
            invalid = invalid | ~CropAnomalyService._qa_clear(qa_image[0].astype("uint16"))

        celsius = np.ma.array((lst * scale + offset) - 273.15, mask=invalid)
        if celsius.count() == 0:
            return None
        return float(celsius.mean())

    @staticmethod
    def _mean_raster_for_polygon(href: str, polygon: Polygon) -> float | None:
        with rasterio.open(href) as src:
            transformer = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
            projected_polygon = transform(transformer.transform, polygon)
            image, _ = mask(src, [projected_polygon.__geo_interface__], crop=True, filled=False)

        values = image[0].astype("float32")
        values = np.ma.array(values, mask=np.ma.getmaskarray(values) | (values < 0))
        if values.count() == 0:
            return None
        return float(values.mean())

    @staticmethod
    def _qa_clear(qa: np.ndarray) -> np.ndarray:
        fill = (qa & (1 << 0)) != 0
        dilated_cloud = (qa & (1 << 1)) != 0
        cirrus = (qa & (1 << 2)) != 0
        cloud = (qa & (1 << 3)) != 0
        cloud_shadow = (qa & (1 << 4)) != 0
        snow = (qa & (1 << 5)) != 0
        return ~(fill | dilated_cloud | cirrus | cloud | cloud_shadow | snow)

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
    def _feature_contributions(frame: pd.DataFrame, latest: pd.Series) -> list[dict]:
        baselines = frame[["ndvi", "lst_celsius", "rainfall_mm"]].median()
        spreads = frame[["ndvi", "lst_celsius", "rainfall_mm"]].std().replace(0, 1)
        z_scores = ((latest[["ndvi", "lst_celsius", "rainfall_mm"]] - baselines) / spreads).abs()

        messages = {
            "ndvi": "Sudden NDVI deviation indicates abnormal canopy greenness.",
            "lst_celsius": "High LST combined with vegetation stress suggests crop fever risk.",
            "rainfall_mm": "Rainfall departure can amplify pest, disease, or water-stress risk.",
        }
        directions = {
            key: "above baseline" if latest[key] > baselines[key] else "below baseline"
            for key in messages
        }

        return [
            {
                "feature": feature,
                "value": round(float(latest[feature]), 4),
                "baseline": round(float(baselines[feature]), 4),
                "direction": directions[feature],
                "message": messages[feature],
            }
            for feature in z_scores.sort_values(ascending=False).index
        ]

    @staticmethod
    def _row_to_payload(row: pd.Series) -> dict:
        return {
            "date": row["date"].date() if hasattr(row["date"], "date") else row["date"],
            "ndvi": round(float(row["ndvi"]), 4),
            "lst_celsius": round(float(row["lst_celsius"]), 2),
            "rainfall_mm": round(float(row["rainfall_mm"]), 2),
        }

    @staticmethod
    def _extract_polygon_geometry(payload: dict) -> Polygon:
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump()

        geometry_payload = payload.get("geometry", payload)
        geometry = shape(geometry_payload)
        if geometry.geom_type != "Polygon":
            raise ValueError("Only GeoJSON Polygon geometries are supported.")
        if geometry.is_empty or not geometry.is_valid:
            raise ValueError("Polygon geometry is empty or invalid.")

        gdf = gpd.GeoDataFrame([{"geometry": geometry}], crs="EPSG:4326")
        metric_crs = gdf.estimate_utm_crs() or "EPSG:3857"
        if gdf.to_crs(metric_crs).geometry.iloc[0].area <= 0:
            raise ValueError("Polygon must have a positive area.")
        return geometry
