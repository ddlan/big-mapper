import numpy as np

EARTH_RADIUS_M = 6_371_008.8


def haversine_m(lon1, lat1, lon2, lat2):
    lon1, lat1, lon2, lat2 = (np.radians(np.asarray(a, dtype=np.float64)) for a in (lon1, lat1, lon2, lat2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(a))


def points_in_polygon(lon, lat, polygon):
    """Vectorized even-odd ray casting. polygon: list of (lon, lat)."""
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    inside = np.zeros(lon.shape, dtype=bool)
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        crosses = (y1 > lat) != (y2 > lat)
        with np.errstate(divide="ignore", invalid="ignore"):
            x_at = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
        inside ^= crosses & (lon < x_at)
    return inside


def project_local_m(lon, lat, lat0):
    """Equirectangular projection to meters around lat0; fine for KD-tree lookups at regional scale."""
    k = np.pi / 180 * EARTH_RADIUS_M
    return np.column_stack([np.asarray(lon) * k * np.cos(np.radians(lat0)), np.asarray(lat) * k])
