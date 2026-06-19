from typing import Any, Literal

from pydantic import BaseModel, Field


class Geometry(BaseModel):
    type: str
    coordinates: Any


class Feature(BaseModel):
    type: Literal["Feature"] = "Feature"
    properties: dict[str, Any] = Field(default_factory=dict)
    geometry: Geometry


class FeatureCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[Feature]
