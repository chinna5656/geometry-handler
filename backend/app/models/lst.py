from datetime import datetime

from pydantic import BaseModel, Field

from app.models.geojson import Feature, Geometry


class LstScene(BaseModel):
    id: str
    datetime: datetime
    cloud_cover: float
    bbox: list[float]
    lst_href: str
    qa_href: str | None = None
    scale: float = 1.0
    offset: float = 0.0


class LstRasterRequest(BaseModel):
    polygon: Feature | Geometry | dict
    days_back: int = Field(default=120, ge=1, le=730)
    max_cloud_cover: float = Field(default=30.0, ge=0, le=100)


class LstRasterResponse(BaseModel):
    session_id: str
    scene: LstScene
    bounds: list[float]
    tile_url: str


class LstInspectResponse(BaseModel):
    longitude: float
    latitude: float
    lst_celsius: float
    class_name: str
