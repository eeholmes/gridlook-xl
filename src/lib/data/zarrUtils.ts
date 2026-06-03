import * as zarr from "zarrita";

import { ZarrDataManager } from "./ZarrDataManager.ts";

import {
  VALUE_TRANSFORMS,
  type TSources,
  type TValueTransform,
} from "@/lib/types/GlobeTypes.ts";

export function getMissingValue(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const attributes = datavar.attrs;
  if (Object.hasOwn(attributes, "missingValue")) {
    return new Float32Array([Number(attributes.missingValue)])[0];
  }
  if (Object.hasOwn(attributes, "missing_value")) {
    return new Float32Array([Number(attributes.missing_value)])[0];
  }
  return NaN;
}

/**
 * Retrieves the fill value from a Zarr array, normalizing across different
 * naming conventions ("fillValue", "fill_value", "_FillValue", "_fillvalue")
 * that various tools and conventions (Zarr v2, CF conventions, xarray, etc.)
 * may use to store it in the metadata attributes.
 */
export function getFillValue(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  if (datavar.fillValue) {
    return datavar.fillValue as number;
  }
  const attributes = datavar.attrs;
  if (Object.hasOwn(attributes, "fillValue")) {
    return new Float32Array([Number(attributes.fillValue)])[0];
  }
  if (Object.hasOwn(attributes, "fill_value")) {
    return new Float32Array([Number(attributes.fill_value)])[0];
  }
  if (Object.hasOwn(attributes, "_FillValue")) {
    return new Float32Array([Number(attributes._FillValue)])[0];
  }
  if (Object.hasOwn(attributes, "_fillvalue")) {
    return new Float32Array([Number(attributes._fillvalue)])[0];
  }
  return NaN;
}

export function getMissingAndFillValues(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  return {
    missingValue: getMissingValue(datavar),
    fillValue: getFillValue(datavar),
  };
}

/**
 * Create a predicate that returns true when a value equals the dataset's
 * missing or fill value (or is NaN).
 */
export function createMissingOrFillPredicate(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const missingValue = getMissingValue(datavar);
  const fillValue = getFillValue(datavar);
  return (value: number) => {
    if (Number.isNaN(value)) {
      return true;
    }
    if (value === missingValue) {
      return true;
    }
    if (value === fillValue) {
      return true;
    }
    return false;
  };
}

export function hasUnits(
  maybeHasUnits: unknown
): maybeHasUnits is { units: string } {
  if (typeof maybeHasUnits !== "object" || maybeHasUnits === null) {
    return false;
  }
  return typeof (maybeHasUnits as { units: string }).units === "string";
}

function getLeafName(name: string) {
  return name.split("/").pop() ?? name;
}

export function isLongitudeVariable(name: string, attrs: unknown) {
  const leafName = getLeafName(name);
  return (
    (hasUnits(attrs) && !!attrs.units.match(/degrees?_?(E|east)/)) ||
    leafName === "lon" ||
    leafName === "longitude"
  );
}

export function isLongitudeName(name: string) {
  // FIXME: Need to check for unit later
  // having "rlon" here is a workaround to catch rotated regular grids if the have no CRS-var
  const leafName = getLeafName(name);
  return leafName === "lon" || leafName === "longitude" || leafName === "rlon";
}

export function isXName(name: string) {
  return getLeafName(name) === "x";
}

export function isYName(name: string) {
  return getLeafName(name) === "y";
}

export function isLatitudeVariable(name: string, attrs: unknown) {
  const leafName = getLeafName(name);
  return (
    (hasUnits(attrs) && !!attrs.units.match(/degrees?_?(N|north)/)) ||
    leafName === "lat" ||
    leafName === "latitude"
  );
}
export function isLatitudeName(name: string) {
  // FIXME: Need to check for unit later
  // having "rlat" here is a workaround to catch rotated regular grids if the have no CRS-var
  const leafName = getLeafName(name);
  return leafName === "lat" || leafName === "latitude" || leafName === "rlat";
}

function lonPriority(name: string) {
  const leafName = getLeafName(name);
  if (leafName === "rlon") {
    return 0;
  }
  if (leafName === "lon") {
    return 1;
  }
  if (leafName === "longitude") {
    return 2;
  }
  return 3;
}

function latPriority(name: string) {
  const leafName = getLeafName(name);
  if (leafName === "rlat") {
    return 0;
  }
  if (leafName === "lat") {
    return 1;
  }
  if (leafName === "latitude") {
    return 2;
  }
  return 3;
}

function sameDimensionNames(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== right.length
  ) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function getSpatialDimensionNames(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  return (
    (datavar.dimensionNames as string[] | undefined)?.filter(
      (dimName) => dimName.toLowerCase() !== "time"
    ) ?? []
  );
}

function findExactLatLonNamesFromSources(
  sources: TSources["levels"][0]["datasources"],
  spatialDimensions: readonly string[]
): { latitudeName: string | null; longitudeName: string | null } {
  let latitudeName: string | null = null;
  let longitudeName: string | null = null;

  for (const sourceKey in sources) {
    const source = sources[sourceKey];
    const dimensions = source.attrs?.dimensionNames as string[] | undefined;
    if (!sameDimensionNames(dimensions, spatialDimensions)) {
      continue;
    }

    if (isLatitudeVariable(sourceKey, source.attrs)) {
      latitudeName = sourceKey;
    }
    if (isLongitudeVariable(sourceKey, source.attrs)) {
      longitudeName = sourceKey;
    }
  }

  return { latitudeName, longitudeName };
}

function resolveLatLonFromCoordinates(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isRotated: boolean
): { latitudeName: string | null; longitudeName: string | null } {
  const coordinates = isRotated
    ? "rlon rlat"
    : (datavar.attrs.coordinates as string);
  let latitudeName: string | null = null;
  let longitudeName: string | null = null;
  if (coordinates) {
    for (const coordName of coordinates.split(/[\s,]+/)) {
      if (isLatitudeName(coordName)) {
        latitudeName = coordName;
      } else if (isLongitudeName(coordName)) {
        longitudeName = coordName;
      }
    }
  }

  if (!latitudeName || !longitudeName) {
    (datavar.dimensionNames as string[]).forEach((dimName: string) => {
      if (!latitudeName && isLatitudeName(dimName)) {
        latitudeName = dimName;
      } else if (!longitudeName && isLongitudeName(dimName)) {
        longitudeName = dimName;
      }
    });
  }
  return { latitudeName, longitudeName };
}

function refineLatLonFromSources(
  sources: TSources["levels"][0]["datasources"],
  latitudeName: string | null,
  longitudeName: string | null
): { latitudeName: string | null; longitudeName: string | null } {
  for (const sourceKey in sources) {
    if (isLatitudeVariable(sourceKey, sources[sourceKey].attrs)) {
      if (
        latitudeName === null ||
        latPriority(sourceKey) < latPriority(latitudeName)
      ) {
        latitudeName = sourceKey;
      }
    } else if (isLongitudeVariable(sourceKey, sources[sourceKey].attrs)) {
      if (
        longitudeName === null ||
        lonPriority(sourceKey) < lonPriority(longitudeName)
      ) {
        longitudeName = sourceKey;
      }
    }
  }
  return { latitudeName, longitudeName };
}

/**
 * This function search for the names of the latitude and longitude variables based on the following behaviour:
 * 1. Get the "coordinates" attribute of the data variable. If the grid is rotated,
 * we enforce "rlon rlat" as the coordinates
 * 2. If 1. failed, use the "dimensionNames" attribute of the data variable
 * 3. We search for variables with longitude/latitude-like names found in the steps 1. and 2. and take
 * 4. If we still don't have lat/lon names, we search for any variable with
 * longitude/latitude-like names and the appropriate unit. If multiple
 * candidates are found (e.g. a variable "lat_vertices" and a variable "lat",
 * both having "degrees_north" as units), we prioritize based on the variable
 * name (e.g., "lat" is preferred over "lat_vertices")
 *
 * FIXME: This function is a heuristic and may fail in some edge cases.
 */
function findLatLonNames(
  datasources: TSources,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isRotated = false
) {
  let { latitudeName, longitudeName } = resolveLatLonFromCoordinates(
    datavar,
    isRotated
  );

  // (re-)assign lat/lon names from sources using priority ordering:
  // Longitude: rlon > lon > longitude > anything else
  // Latitude:  rlat > lat > latitude  > anything else
  if (!latitudeName || !longitudeName) {
    ({ latitudeName, longitudeName } = refineLatLonFromSources(
      datasources.levels[0].datasources,
      latitudeName,
      longitudeName
    ));
  }

  if (!latitudeName || !longitudeName) {
    ({ latitudeName, longitudeName } = findExactLatLonNamesFromSources(
      datasources.levels[0].datasources,
      getSpatialDimensionNames(datavar)
    ));
  }

  return {
    latitudeName: latitudeName ?? "lat",
    longitudeName: longitudeName ?? "lon",
  };
}

function applyScaleFactor(
  data?: zarr.Chunk<zarr.DataType>,
  attributes?: zarr.Attributes
) {
  if (data && attributes?.scale_factor) {
    const scaleFactor = Number(attributes.scale_factor);
    data.data = (data.data as Float32Array).map((v) => v * scaleFactor);
  }
}

async function fetchLatLonVariables(
  datasources: TSources,
  currentVarname: string,
  latitudeName: string,
  longitudeName: string
) {
  const latitudeReference = ZarrDataManager.resolveVariableReference(
    datasources,
    currentVarname,
    latitudeName
  );

  const longitudeReference = ZarrDataManager.resolveVariableReference(
    datasources,
    currentVarname,
    longitudeName
  );

  const [latitudesVar, longitudesVar] = await Promise.all([
    ZarrDataManager.getVariableInfo(
      latitudeReference.datasource,
      latitudeReference.variable,
      datasources.zarr_format
    ),
    ZarrDataManager.getVariableInfo(
      longitudeReference.datasource,
      longitudeReference.variable,
      datasources.zarr_format
    ).catch(() => null),
  ]);

  return { latitudesVar, longitudesVar };
}

/**
 * Returns lat/lon {@link zarr.Array} metadata objects without fetching any
 * chunk data. Useful for shape-based grid-type detection (e.g. curvilinear
 * check) where only array dimensions are needed, not the coordinate values.
 */
export async function getLatLonVariableInfo(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources,
  currentVarname: string,
  isRotated = false
) {
  const { latitudeName, longitudeName } = findLatLonNames(
    datasources,
    datavar,
    isRotated
  );
  return fetchLatLonVariables(
    datasources,
    currentVarname,
    latitudeName,
    longitudeName
  );
}

export async function getLatLonData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined,
  currentVarname: string,
  isRotated = false
) {
  const { latitudeName, longitudeName } = findLatLonNames(
    datasources!,
    datavar,
    isRotated
  );

  const { latitudesVar, longitudesVar } = await fetchLatLonVariables(
    datasources!,
    currentVarname,
    latitudeName,
    longitudeName
  );

  const [latitudes, longitudesOrNull] = await Promise.all([
    ZarrDataManager.getVariableDataFromArray(latitudesVar),
    longitudesVar
      ? ZarrDataManager.getVariableDataFromArray(longitudesVar)
      : Promise.resolve(null),
  ]);

  const longitudes = longitudesOrNull;

  const returnObject = {
    latitudesAttrs: {
      dimensionNames: latitudesVar.dimensionNames,
      ...latitudesVar.attrs,
    },
    latitudes,
    longitudesAttrs: longitudesVar
      ? { dimensionNames: longitudesVar.dimensionNames, ...longitudesVar.attrs }
      : null,
    longitudes,
  };

  applyScaleFactor(returnObject.latitudes, returnObject.latitudesAttrs);
  applyScaleFactor(
    returnObject.longitudes ?? undefined,
    returnObject.longitudesAttrs ?? undefined
  );

  return returnObject;
}

export function getDataBounds(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  data: Float32Array<ArrayBufferLike>
) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const missingValue = getMissingValue(datavar);
  const fillValue = getFillValue(datavar);

  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === missingValue || v === fillValue || !Number.isFinite(v)) {
      continue;
    }
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
  }

  if (min === Number.POSITIVE_INFINITY) {
    min = NaN;
  }
  if (max === Number.NEGATIVE_INFINITY) {
    max = NaN;
  }
  return {
    min: min,
    max: max,
    fillValue: fillValue,
    missingValue: missingValue,
  };
}

export function mapMissingAndFillToNaN(
  data: Float32Array<ArrayBufferLike>,
  missingValue: number,
  fillValue: number
) {
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (
      !Number.isFinite(value) ||
      value === missingValue ||
      value === fillValue
    ) {
      data[i] = NaN;
    }
  }
  return data;
}

export function applyDisplayTransformToData(
  data: Float32Array<ArrayBufferLike>,
  transformMode: TValueTransform
) {
  if (transformMode === VALUE_TRANSFORMS.LINEAR) {
    return data;
  }

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    // Logarithmic display mode: zero/negative/non-finite values are invalid.
    data[i] =
      Number.isFinite(value) && value > 0 ? Math.log10(value) : Number.NaN;
  }

  return data;
}

/**
 * Gridlook cannot handle Float16, Float64, or integer types in textures,
 * so cast compatible numeric arrays to Float32.
 */
function isFloat32ConvertibleArray(
  rawData: unknown
): rawData is ArrayBufferView<ArrayBufferLike> & ArrayLike<number> {
  return (
    ArrayBuffer.isView(rawData) &&
    !(rawData instanceof DataView) &&
    !(rawData instanceof Float32Array) &&
    !(rawData instanceof BigInt64Array) &&
    !(rawData instanceof BigUint64Array)
  );
}

export function castDataVarToFloat32(
  rawData:
    | unknown[]
    | Int8Array<ArrayBufferLike>
    | Int16Array<ArrayBufferLike>
    | Int32Array<ArrayBufferLike>
    | BigInt64Array<ArrayBufferLike>
    | Uint8Array<ArrayBufferLike>
    | Uint16Array<ArrayBufferLike>
    | Uint32Array<ArrayBufferLike>
    | BigUint64Array<ArrayBufferLike>
    | Float32Array<ArrayBufferLike>
    | Float64Array<ArrayBufferLike>
    | zarr.BoolArray
    | zarr.UnicodeStringArray
    | zarr.ByteStringArray
    | zarr.Chunk<zarr.DataType>
) {
  if (rawData instanceof Float32Array) {
    return rawData;
  }
  if (isFloat32ConvertibleArray(rawData)) {
    return Float32Array.from(rawData);
  }
  if (Array.isArray(rawData)) {
    return Float32Array.from(rawData);
  }
  const receivedType =
    rawData === null
      ? "null"
      : rawData === undefined
        ? "undefined"
        : (rawData.constructor?.name ?? typeof rawData);
  throw new TypeError(
    `Unsupported data type for Float32 texture conversion. Expected a numeric typed array or array-like input, received: ${receivedType}`
  );
}

// ---------------------------------------------------------------------------
// XY (projected) coordinate support
// ---------------------------------------------------------------------------

/** Earth radius used by the Web Mercator (EPSG:3857) projection. */
const WEB_MERCATOR_RADIUS = 6378137;

/**
 * Convert a Web Mercator easting (metres, valid range: ±20037508.34) to a
 * WGS-84 longitude in degrees (output range: −180 to +180).
 */
export function webMercatorXToLon(x: number): number {
  return (x / WEB_MERCATOR_RADIUS) * (180 / Math.PI);
}

/**
 * Convert a Web Mercator northing (metres, valid range: ±20037508.34) to a
 * WGS-84 latitude in degrees (output range: approximately −85.05 to +85.05).
 */
export function webMercatorYToLat(y: number): number {
  return (Math.atan(Math.sinh(y / WEB_MERCATOR_RADIUS)) * 180) / Math.PI;
}

/**
 * Returns true when the WKT string describes the Web Mercator projection
 * (EPSG:3857 / Pseudo-Mercator).
 */
export function isWebMercatorCRS(crsWkt: string): boolean {
  return (
    crsWkt.includes('AUTHORITY["EPSG","3857"]') ||
    crsWkt.includes("AUTHORITY['EPSG','3857']") ||
    crsWkt.toLowerCase().includes("pseudo-mercator") ||
    crsWkt.includes("+proj=merc")
  );
}

/**
 * Read the 1-D `x` and `y` coordinate arrays from a dataset that uses a
 * projected CRS (e.g. EPSG:3857 / Web Mercator) and convert them to
 * WGS-84 latitude / longitude arrays suitable for the Regular grid renderer.
 *
 * The CRS is inferred from the `spatial_ref` (or equivalent) variable that is
 * referenced in the data variable's `coordinates` attribute.
 *
 * @throws {Error} when the CRS is not currently supported.
 */
export async function getXYCoordinatesAsLatLon(
  datasources: TSources,
  currentVarname: string
): Promise<{
  latitudes: Float64Array<ArrayBuffer>;
  longitudes: Float64Array<ArrayBuffer>;
}> {
  const xRef = ZarrDataManager.resolveVariableReference(
    datasources,
    currentVarname,
    "x"
  );
  const yRef = ZarrDataManager.resolveVariableReference(
    datasources,
    currentVarname,
    "y"
  );

  const [xArray, yArray] = await Promise.all([
    ZarrDataManager.getVariableInfo(
      xRef.datasource,
      xRef.variable,
      datasources.zarr_format
    ),
    ZarrDataManager.getVariableInfo(
      yRef.datasource,
      yRef.variable,
      datasources.zarr_format
    ),
  ]);

  const [xData, yData] = await Promise.all([
    ZarrDataManager.getVariableDataFromArray(xArray),
    ZarrDataManager.getVariableDataFromArray(yArray),
  ]);

  const crs = await ZarrDataManager.getCRSInfo(datasources, currentVarname);
  const crsWkt = String(crs.attrs?.crs_wkt ?? crs.attrs?.spatial_ref ?? "");

  if (isWebMercatorCRS(crsWkt)) {
    const xRaw = castDataVarToFloat32(xData.data);
    const yRaw = castDataVarToFloat32(yData.data);
    const longitudes = new Float64Array(xRaw.length);
    const latitudes = new Float64Array(yRaw.length);
    for (let i = 0; i < xRaw.length; i++) {
      longitudes[i] = webMercatorXToLon(xRaw[i]);
    }
    for (let i = 0; i < yRaw.length; i++) {
      latitudes[i] = webMercatorYToLat(yRaw[i]);
    }
    return { latitudes, longitudes };
  }

  throw new Error(
    `Unsupported projected CRS for xy grid. Only Web Mercator (EPSG:3857) is ` +
      `currently supported. CRS: ${crsWkt.slice(0, 120)}`
  );
}

// ---------------------------------------------------------------------------
// Polar Stereographic projection support
// ---------------------------------------------------------------------------

/**
 * Returns true when the string (WKT or PROJ4) describes a polar
 * stereographic projection.
 */
export function isPolarStereographicCRS(str: string): boolean {
  const lower = str.toLowerCase();
  return (
    lower.includes("polar_stereographic") ||
    (lower.includes("+proj=stere") &&
      (lower.includes("+lat_0=-90") ||
        lower.includes("+lat_0=90") ||
        /\+lat_ts=-?\d/.test(lower)))
  );
}

/**
 * Retrieve a CRS string (WKT or PROJ4) describing the coordinate reference
 * system for an XY grid variable.  Tries the dedicated CRS variable first,
 * then falls back to group-level PROJ4 attributes written by rioxarray.
 *
 * Returns an empty string when no CRS information is found.
 */
export async function getCRSStringForXYVariable(
  datasources: TSources,
  currentVarname: string
): Promise<string> {
  try {
    const crs = await ZarrDataManager.getCRSInfo(datasources, currentVarname);
    if (crs.attrs?.grid_mapping_name === "polar_stereographic") {
      return "polar_stereographic";
    }
    const wkt = String(crs.attrs?.crs_wkt ?? crs.attrs?.spatial_ref ?? "");
    if (wkt) {
      return wkt;
    }
  } catch {
    // No CRS variable found
  }
  try {
    const source = ZarrDataManager.getDatasetSource(
      datasources,
      currentVarname
    );
    const group = await ZarrDataManager.getDatasetGroup(source);
    const proj4 = String(group.attrs?.proj4_params ?? "");
    if (proj4) {
      return proj4;
    }
  } catch {
    // No group-level CRS attrs
  }
  return "";
}

/** WGS-84 semi-major axis in metres, used for inverse polar stereographic. */
const WGS84_SEMI_MAJOR_AXIS_M = 6378137.0;

/** Minimum distance (m) from the pole below which a point is treated as exactly at the pole. */
const POLE_PROXIMITY_THRESHOLD_M = 1e-3;

/**
 * Inverse spherical polar stereographic projection.
 *
 * Converts a single (x, y) point in the projected coordinate system
 * (units: metres, origin at pole) to geographic (lat, lon) in degrees.
 *
 * Derivation: standard spherical inverse stereographic with φ₀ = ±90°.
 *   ρ = √(x² + y²)
 *   c = 2·atan(ρ / 2R)
 *   North: φ = 90 − c·(180/π),  λ = λ₀ + atan2(x, −y)·(180/π)
 *   South: φ = −90 + c·(180/π), λ = λ₀ + atan2(x,  y)·(180/π)
 *
 * A spherical Earth is assumed (k₀ = 1).  For WGS-84-based projections
 * such as EPSG:3031 (lat_ts = −71°) the coordinate error is < 1° near
 * the standard parallel, which is acceptable for visualisation.
 */
function invPolarStereoPoint(
  x: number,
  y: number,
  isNorthPole: boolean,
  centralMeridian: number
): { lat: number; lon: number } {
  const R = WGS84_SEMI_MAJOR_AXIS_M;
  const rho = Math.sqrt(x * x + y * y);
  if (rho < POLE_PROXIMITY_THRESHOLD_M) {
    return { lat: isNorthPole ? 90 : -90, lon: centralMeridian };
  }
  const c = 2 * Math.atan2(rho, 2 * R);
  const lat = isNorthPole
    ? 90 - (c * 180) / Math.PI
    : -90 + (c * 180) / Math.PI;
  const lonRaw = isNorthPole
    ? (Math.atan2(x, -y) * 180) / Math.PI
    : (Math.atan2(x, y) * 180) / Math.PI;
  // Apply central-meridian rotation and normalise to (−180, 180].
  let lon = lonRaw + centralMeridian;
  if (lon > 180) {
    lon -= 360;
  }
  if (lon <= -180) {
    lon += 360;
  }
  return { lat, lon };
}

/**
 * Extract the hemisphere and central meridian from the CRS variable
 * attached to `currentVarname`.  Falls back to the proj4_params group
 * attribute when no dedicated CRS variable is present.
 *
 * @returns `{ isNorthPole, centralMeridian }` where `centralMeridian`
 *          is in degrees.
 */
export async function getPolarStereoCRSParams(
  datasources: TSources,
  currentVarname: string
): Promise<{ isNorthPole: boolean; centralMeridian: number }> {
  // Try the CRS variable first.
  try {
    const crs = await ZarrDataManager.getCRSInfo(datasources, currentVarname);
    const latOrigin = Number(
      crs.attrs?.latitude_of_projection_origin ?? crs.attrs?.lat_0 ?? NaN
    );
    if (Number.isFinite(latOrigin)) {
      const centralMeridian = Number(
        crs.attrs?.straight_vertical_longitude_from_pole ??
          crs.attrs?.central_meridian ??
          crs.attrs?.lon_0 ??
          0
      );
      return { isNorthPole: latOrigin >= 0, centralMeridian };
    }
  } catch {
    // No CRS variable or attributes — fall through.
  }

  // Fall back to parsing the PROJ4 string.
  try {
    const source = ZarrDataManager.getDatasetSource(
      datasources,
      currentVarname
    );
    const group = await ZarrDataManager.getDatasetGroup(source);
    const proj4 = String(group.attrs?.proj4_params ?? "");
    if (proj4) {
      const lat0Match = proj4.match(/\+lat_0=(-?\d+(?:\.\d+)?)/);
      const lon0Match = proj4.match(/\+lon_0=(-?\d+(?:\.\d+)?)/);
      const latOrigin = lat0Match ? parseFloat(lat0Match[1]) : NaN;
      const centralMeridian = lon0Match ? parseFloat(lon0Match[1]) : 0;
      if (Number.isFinite(latOrigin)) {
        return { isNorthPole: latOrigin >= 0, centralMeridian };
      }
    }
  } catch {
    // No group-level attrs — fall through.
  }

  // Ultimate fallback: assume South Pole (most common for polar datasets).
  return { isNorthPole: false, centralMeridian: 0 };
}

/**
 * Compute proper geographic (lat/lon) 2-D coordinate arrays for a polar
 * stereographic x/y grid by applying the inverse polar stereographic
 * projection to every (xᵢ, yⱼ) grid point.
 *
 * The returned flat arrays have length `ny × nx` and are laid out in
 * row-major order (j-major, i-minor), matching the data array layout
 * expected by the Curvilinear grid renderer.
 */
export async function computePolarStereoLatLon2D(
  datasources: TSources,
  currentVarname: string
): Promise<{
  latitudes2D: Float64Array;
  longitudes2D: Float64Array;
  ny: number;
  nx: number;
  isNorthPole: boolean;
}> {
  const xRef = ZarrDataManager.resolveVariableReference(
    datasources,
    currentVarname,
    "x"
  );
  const yRef = ZarrDataManager.resolveVariableReference(
    datasources,
    currentVarname,
    "y"
  );

  const [xArray, yArray] = await Promise.all([
    ZarrDataManager.getVariableInfo(
      xRef.datasource,
      xRef.variable,
      datasources.zarr_format
    ),
    ZarrDataManager.getVariableInfo(
      yRef.datasource,
      yRef.variable,
      datasources.zarr_format
    ),
  ]);

  const [xData, yData, { isNorthPole, centralMeridian }] = await Promise.all([
    ZarrDataManager.getVariableDataFromArray(xArray),
    ZarrDataManager.getVariableDataFromArray(yArray),
    getPolarStereoCRSParams(datasources, currentVarname),
  ]);

  const xRaw = castDataVarToFloat32(xData.data); // 1-D, length nx
  const yRaw = castDataVarToFloat32(yData.data); // 1-D, length ny
  const nx = xRaw.length;
  const ny = yRaw.length;

  const latitudes2D = new Float64Array(ny * nx);
  const longitudes2D = new Float64Array(ny * nx);

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const { lat, lon } = invPolarStereoPoint(
        xRaw[i],
        yRaw[j],
        isNorthPole,
        centralMeridian
      );
      latitudes2D[j * nx + i] = lat;
      longitudes2D[j * nx + i] = lon;
    }
  }

  return { latitudes2D, longitudes2D, ny, nx, isNorthPole };
}
