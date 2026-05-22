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

export function isLongitudeVariable(name: string, attrs: unknown) {
  return (
    (hasUnits(attrs) && !!attrs.units.match(/degrees?_?(E|east)/)) ||
    name === "lon" ||
    name === "longitude"
  );
}

export function isLongitudeName(name: string) {
  // FIXME: Need to check for unit later
  // having "rlon" here is a workaround to catch rotated regular grids if the have no CRS-var
  return name === "lon" || name === "longitude" || name === "rlon";
}

export function isXName(name: string) {
  return name === "x";
}

export function isYName(name: string) {
  return name === "y";
}

export function isLatitudeVariable(name: string, attrs: unknown) {
  return (
    (hasUnits(attrs) && !!attrs.units.match(/degrees?_?(N|north)/)) ||
    name === "lat" ||
    name === "latitude"
  );
}
export function isLatitudeName(name: string) {
  // FIXME: Need to check for unit later
  // having "rlat" here is a workaround to catch rotated regular grids if the have no CRS-var
  return name === "lat" || name === "latitude" || name === "rlat";
}

function lonPriority(name: string) {
  if (name === "rlon") {
    return 0;
  }
  if (name === "lon") {
    return 1;
  }
  if (name === "longitude") {
    return 2;
  }
  return 3;
}

function latPriority(name: string) {
  if (name === "rlat") {
    return 0;
  }
  if (name === "lat") {
    return 1;
  }
  if (name === "latitude") {
    return 2;
  }
  return 3;
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
    for (const coordName of coordinates.split(" ")) {
      if (isLatitudeName(coordName)) {
        latitudeName = coordName;
      } else if (isLongitudeName(coordName)) {
        longitudeName = coordName;
      }
    }
  } else {
    (datavar.dimensionNames as string[]).forEach((dimName: string) => {
      if (isLatitudeName(dimName)) {
        latitudeName = dimName;
      } else if (isLongitudeName(dimName)) {
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

  const latitudesVar = await ZarrDataManager.getVariableInfo(
    latitudeReference.datasource,
    latitudeReference.variable
  );

  let longitudesVar: zarr.Array<zarr.DataType, zarr.AsyncReadable> | null =
    null;
  try {
    const longitudeReference = ZarrDataManager.resolveVariableReference(
      datasources,
      currentVarname,
      longitudeName
    );
    longitudesVar = await ZarrDataManager.getVariableInfo(
      longitudeReference.datasource,
      longitudeReference.variable
    );
  } catch {
    // Longitude variable doesn't exist - this is a lat-only dataset
  }

  return { latitudesVar, longitudesVar };
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

  const latitudes =
    await ZarrDataManager.getVariableDataFromArray(latitudesVar);

  let longitudes: zarr.Chunk<zarr.DataType> | null = null;
  if (longitudesVar) {
    longitudes = await ZarrDataManager.getVariableDataFromArray(longitudesVar);
  }

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

/** Convert a Web Mercator easting (metres) to a WGS-84 longitude (degrees). */
export function webMercatorXToLon(x: number): number {
  return (x / WEB_MERCATOR_RADIUS) * (180 / Math.PI);
}

/** Convert a Web Mercator northing (metres) to a WGS-84 latitude (degrees). */
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
    ZarrDataManager.getVariableInfo(xRef.datasource, xRef.variable),
    ZarrDataManager.getVariableInfo(yRef.datasource, yRef.variable),
  ]);

  const [xData, yData] = await Promise.all([
    ZarrDataManager.getVariableDataFromArray(xArray),
    ZarrDataManager.getVariableDataFromArray(yArray),
  ]);

  const crs = await ZarrDataManager.getCRSInfo(datasources, currentVarname);
  const crsWkt = String(crs.attrs?.crs_wkt ?? crs.attrs?.spatial_ref ?? "");

  if (isWebMercatorCRS(crsWkt)) {
    const xRaw = xData.data as Float32Array;
    const yRaw = yData.data as Float32Array;
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
