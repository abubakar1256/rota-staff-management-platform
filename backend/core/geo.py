from math import asin, cos, radians, sin, sqrt


def haversine_distance_m(latitude_a, longitude_a, latitude_b, longitude_b):
    earth_radius_m = 6371000
    lat_delta = radians(latitude_b - latitude_a)
    lon_delta = radians(longitude_b - longitude_a)
    a = sin(lat_delta / 2) ** 2 + cos(radians(latitude_a)) * cos(radians(latitude_b)) * sin(lon_delta / 2) ** 2
    return earth_radius_m * 2 * asin(sqrt(min(1, max(0, a))))
