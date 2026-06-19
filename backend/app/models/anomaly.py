from datetime import date

from pydantic import BaseModel, Field

from app.models.geojson import Feature, Geometry


class AnomalyScoreRequest(BaseModel):
    polygon: Feature | Geometry | dict
    start_date: date
    end_date: date
    max_cloud_cover: float = Field(default=35.0, ge=0, le=100)
    rainfall_window_days: int = Field(default=7, ge=1, le=30)
    contamination: float = Field(default=0.12, gt=0, le=0.5)


class FeatureContribution(BaseModel):
    feature: str
    value: float
    baseline: float
    direction: str
    message: str


class AnomalyFeatureRow(BaseModel):
    date: date
    ndvi: float
    lst_celsius: float
    rainfall_mm: float


class AnomalyScoreResponse(BaseModel):
    status: str
    is_anomaly: bool
    anomaly_score: float
    label: str
    latest_features: AnomalyFeatureRow
    feature_history: list[AnomalyFeatureRow]
    contributions: list[FeatureContribution]
