from fastapi import APIRouter, HTTPException

from app.models.anomaly import AnomalyScoreRequest, AnomalyScoreResponse
from app.services.anomaly_service import CropAnomalyService

router = APIRouter(prefix="/anomaly", tags=["anomaly"])
service = CropAnomalyService()


@router.post("/score", response_model=AnomalyScoreResponse)
def score_crop_anomaly(payload: AnomalyScoreRequest) -> AnomalyScoreResponse:
    try:
        result = service.score_plot(
            polygon=payload.polygon,
            start_date=payload.start_date,
            end_date=payload.end_date,
            max_cloud_cover=payload.max_cloud_cover,
            rainfall_window_days=payload.rainfall_window_days,
            contamination=payload.contamination,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return AnomalyScoreResponse(**result)
