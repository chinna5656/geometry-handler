from fastapi import APIRouter

from app.models.geojson import FeatureCollection
from app.services.plot_service import PlotService

router = APIRouter(prefix="/plots", tags=["plots"])
service = PlotService()


@router.get("", response_model=FeatureCollection)
def list_plots() -> FeatureCollection:
    """Placeholder plot boundaries.

    Replace this with a spatial database query, uploaded farm boundary GeoJSON,
    or a GeoPackage/PostGIS source.
    """
    return FeatureCollection(features=service.list_demo_plots())
