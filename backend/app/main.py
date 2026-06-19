from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import anomaly, health, lst, ndvi, plots
from app.core.config import settings


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description="Geospatial API for plot-level Sentinel-2 NDVI crop health analytics.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router, prefix=settings.api_prefix)
    app.include_router(plots.router, prefix=settings.api_prefix)
    app.include_router(ndvi.router, prefix=settings.api_prefix)
    app.include_router(ndvi.router, prefix="/api")
    app.include_router(lst.router, prefix=settings.api_prefix)
    app.include_router(lst.router, prefix="/api")
    app.include_router(anomaly.router, prefix=settings.api_prefix)
    app.include_router(anomaly.router, prefix="/api")

    return app


app = create_app()
