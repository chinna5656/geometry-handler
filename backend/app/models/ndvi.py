from datetime import date, datetime

from pydantic import BaseModel, Field

from app.models.geojson import Feature, Geometry


class NdviScene(BaseModel):
    id: str
    datetime: datetime
    cloud_cover: float
    bbox: list[float]
    red_href: str
    nir_href: str


class NdviSearchResponse(BaseModel):
    scenes: list[NdviScene]


class NdviRasterRequest(BaseModel):
    polygon: Feature | Geometry | dict
    days_back: int = Field(default=90, ge=1, le=365)
    max_cloud_cover: float = Field(default=20.0, ge=0, le=100)


class NdviRasterResponse(BaseModel):
    session_id: str
    scene: NdviScene
    bounds: list[float]
    tile_url: str


class NdviInspectResponse(BaseModel):
    longitude: float
    latitude: float
    ndvi: float
    class_name: str


class NdviTimeSeriesRequest(BaseModel):
    polygon: Feature | Geometry | dict
    start_date: date
    end_date: date
    max_cloud_cover: float = Field(default=30.0, ge=0, le=100)


class NdviTimeSeriesPoint(BaseModel):
    date: date
    mean_ndvi: float


class NdviTimeSeriesResponse(BaseModel):
    points: list[NdviTimeSeriesPoint]
