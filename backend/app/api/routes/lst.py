from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.models.lst import LstInspectResponse, LstRasterRequest, LstRasterResponse, LstScene
from app.services.lst_service import LstService

router = APIRouter(prefix="/lst", tags=["lst"])
service = LstService()


@router.post("/raster", response_model=LstRasterResponse)
def create_lst_raster(payload: LstRasterRequest, request: Request) -> LstRasterResponse:
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
    lst_route_prefix = request.url.path.removesuffix("/raster")
    tile_url = (
        f"{api_root}{lst_route_prefix}/raster/{session['session_id']}"
        "/tiles/{z}/{x}/{y}.png"
    )

    return LstRasterResponse(
        session_id=session["session_id"],
        scene=LstScene(**session["scene"]),
        bounds=session["bounds"],
        tile_url=tile_url,
    )


@router.get("/raster/{session_id}/tiles/{z}/{x}/{y}.png")
def lst_raster_tile(session_id: str, z: int, x: int, y: int) -> Response:
    try:
        png = service.render_session_tile(session_id=session_id, z=z, x=x, y=y)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return Response(content=png, media_type="image/png")


@router.get("/raster/{session_id}/inspect", response_model=LstInspectResponse)
def inspect_lst_pixel(
    session_id: str,
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
) -> LstInspectResponse:
    try:
        result = service.inspect_pixel(session_id=session_id, lon=lon, lat=lat)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return LstInspectResponse(**result)
