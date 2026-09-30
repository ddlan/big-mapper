// Normalized Web Mercator (0..1, y down), matching MapLibre's internal coords.

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

export const lonToMercX = (lon: number) => (lon + 180) / 360;

export const latToMercY = (lat: number) =>
  (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;

export const mercXToLon = (x: number) => x * 360 - 180;

export const mercYToLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** Ground meters per normalized mercator unit at a given latitude. */
export const metersPerMercUnit = (lat: number) => EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180);
