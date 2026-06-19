from datetime import date

import planetary_computer
from pystac_client import Client

from app.core.config import settings


class SentinelStacService:
    collection = "sentinel-2-l2a"

    def __init__(self) -> None:
        self.client = Client.open(str(settings.planetary_computer_stac_url))

    def search(
        self,
        bbox: list[float],
        start_date: date,
        end_date: date,
        max_cloud_cover: float,
        limit: int = 10,
    ) -> list[dict]:
        search = self.client.search(
            collections=[self.collection],
            bbox=bbox,
            datetime=f"{start_date.isoformat()}/{end_date.isoformat()}",
            query={"eo:cloud_cover": {"lt": max_cloud_cover}},
            sortby=[{"field": "properties.datetime", "direction": "desc"}],
            max_items=limit,
        )

        scenes: list[dict] = []
        for item in search.items():
            signed = planetary_computer.sign(item)
            red = signed.assets.get("B04")
            nir = signed.assets.get("B08")
            if red is None or nir is None:
                continue

            scenes.append(
                {
                    "id": signed.id,
                    "datetime": signed.datetime,
                    "cloud_cover": signed.properties.get("eo:cloud_cover", 0.0),
                    "bbox": signed.bbox,
                    "red_href": red.href,
                    "nir_href": nir.href,
                }
            )

        return scenes
