from datetime import date

from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.models.ndvi import (
    NdviInspectResponse,
    NdviRasterRequest,
    NdviRasterResponse,
    NdviScene,
    NdviSearchResponse,
    NdviTimeSeriesRequest,
    NdviTimeSeriesResponse,
)
from app.services.ndvi_service import NdviService

router = APIRouter(prefix="/ndvi", tags=["ndvi"])
service = NdviService()


@router.get("/scenes", response_model=NdviSearchResponse)
def search_scenes(
    bbox: str = Query(..., description="WGS84 bbox: minLon,minLat,maxLon,maxLat"),
    start_date: date = Query(...),
    end_date: date = Query(...),
    max_cloud_cover: float = Query(20.0, ge=0, le=100),
) -> NdviSearchResponse:
    try:
        scenes = service.search_scenes(
            bbox=bbox,
            start_date=start_date,
            end_date=end_date,
            max_cloud_cover=max_cloud_cover,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return NdviSearchResponse(scenes=[NdviScene(**scene) for scene in scenes])


@router.post("/raster", response_model=NdviRasterResponse)
def create_ndvi_raster(payload: NdviRasterRequest, request: Request) -> NdviRasterResponse:
    """Create a polygon-scoped NDVI raster session from the latest cloud-free scene."""
    try:
        session = service.create_raster_session(
            polygon=payload.polygon,
            days_back=payload.days_back,
            max_cloud_cover=payload.max_cloud_cover,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    api_root = str(request.base_url).rstrip("/")
    ndvi_route_prefix = request.url.path.removesuffix("/raster")
    tile_url = (
        f"{api_root}{ndvi_route_prefix}/raster/{session['session_id']}"
        "/tiles/{z}/{x}/{y}.png"
    )

    return NdviRasterResponse(
        session_id=session["session_id"],
        scene=NdviScene(**session["scene"]),
        bounds=session["bounds"],
        tile_url=tile_url,
    )


@router.get("/raster/{session_id}/tiles/{z}/{x}/{y}.png")
def ndvi_raster_tile(session_id: str, z: int, x: int, y: int) -> Response:
    try:
        png = service.render_session_tile(session_id=session_id, z=z, x=x, y=y)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return Response(content=png, media_type="image/png")


@router.get("/raster/{session_id}/inspect", response_model=NdviInspectResponse)
def inspect_ndvi_pixel(
    session_id: str,
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
) -> NdviInspectResponse:
    try:
        result = service.inspect_pixel(session_id=session_id, lon=lon, lat=lat)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return NdviInspectResponse(**result)


@router.post("/time-series", response_model=NdviTimeSeriesResponse)
def create_ndvi_time_series(payload: NdviTimeSeriesRequest) -> NdviTimeSeriesResponse:
    try:
        points = service.calculate_time_series(
            polygon=payload.polygon,
            start_date=payload.start_date,
            end_date=payload.end_date,
            max_cloud_cover=payload.max_cloud_cover,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return NdviTimeSeriesResponse(points=points)


@router.get("/tiles/{scene_id}/{z}/{x}/{y}.png")
def ndvi_tile(scene_id: str, z: int, x: int, y: int) -> Response:
    """Return an NDVI raster tile for Mapbox GL raster overlays.

    Dynamic tile generation is suitable for prototyping. For production,
    precompute cloud-masked NDVI COGs by plot/date and serve them through
    a tile cache or dedicated dynamic tiler.
    """
    try:
        png = service.render_ndvi_tile(scene_id=scene_id, z=z, x=x, y=y)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return Response(content=png, media_type="image/png")
