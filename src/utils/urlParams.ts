const URL_PARAMETERS = {
  VARNAME: "varname",
  COLORMAP: "colormap",
  INVERT_COLORMAP: "invertcolormap",
  POSTERIZE_LEVELS: "posterizelevels",
  HIDE_LOWER_BOUND: "hidelowerbound",
  DISTRACTION_FREE: "distractionFree",
  USER_BOUNDS_LOW: "boundlow",
  USER_BOUNDS_HIGH: "boundhigh",
  CAMERA_STATE: "camerastate",
  MASK_MODE: "maskmode",
  MASK_USE_TEXTURE: "maskusetexture",
  PROJECTION: "projection",
  PROJECTION_CENTER_LAT: "projectionCenterLat",
  PROJECTION_CENTER_LON: "projectionCenterLon",
  GRID_TYPE: "gridtype",
  CATALOG: "catalog",
  CRS: "crs",
  DIM_INDICES: "dimIndices",
  DIM_MIN_BOUNDS: "dimMinBounds",
  DIM_MAX_BOUNDS: "dimMaxBounds",
} as const;

type TURLParameterValues = (typeof URL_PARAMETERS)[keyof typeof URL_PARAMETERS];

export function getHashUrlParams(): URLSearchParams {
  if (typeof window === "undefined") {
    return new URLSearchParams();
  }
  const paramArray = window.location.hash.substring(1).split("::").slice(1);
  return new URLSearchParams(paramArray.join("&"));
}

export { URL_PARAMETERS };
export type { TURLParameterValues };
