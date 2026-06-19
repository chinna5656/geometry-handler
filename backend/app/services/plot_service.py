import geopandas as gpd
from pyproj import CRS
from shapely.geometry import Polygon, mapping


class PlotService:
    source_crs = CRS.from_epsg(4326)
    metric_crs = CRS.from_epsg(32647)

    def list_demo_plots(self) -> list[dict]:
        polygon = Polygon(
            [
                (100.501, 13.756),
                (100.511, 13.756),
                (100.511, 13.766),
                (100.501, 13.766),
                (100.501, 13.756),
            ]
        )

        frame = gpd.GeoDataFrame(
            [{"id": "plot-001", "name": "North Field", "geometry": polygon}],
            crs=self.source_crs,
        )
        metric_frame = frame.to_crs(self.metric_crs)
        frame["area_ha"] = (metric_frame.area / 10_000).round(2)

        return [
            {
                "type": "Feature",
                "properties": {
                    "id": row.id,
                    "name": row.name,
                    "area_ha": row.area_ha,
                },
                "geometry": mapping(row.geometry),
            }
            for row in frame.itertuples()
        ]
