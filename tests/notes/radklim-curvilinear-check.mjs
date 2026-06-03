import { indexFromZarr } from "../../src/lib/data/sourceIndexing.ts";
import { getGridType } from "../../src/lib/data/gridTypeDetector.ts";
import { ZarrDataManager } from "../../src/lib/data/ZarrDataManager.ts";
import { getLatLonVariableInfo } from "../../src/lib/data/zarrUtils.ts";

const URL =
  "https://object-store.os-api.cci2.ecmwf.int/mlcast-source-datasets/radklim/v0.1.0/hourly.zarr/";
const VAR = "RR";

function leafName(name) {
  return name.split("/").pop() ?? name;
}

function formatAttrs(attrs) {
  return {
    dimensionNames: attrs?.dimensionNames ?? null,
    standard_name: attrs?.standard_name ?? null,
    long_name: attrs?.long_name ?? null,
    units: attrs?.units ?? null,
  };
}

function isLatLonCandidate(name, attrs) {
  const leaf = leafName(name);
  const lat =
    leaf === "lat" ||
    leaf === "latitude" ||
    attrs?.standard_name === "latitude" ||
    String(attrs?.units ?? "").includes("degrees_north");
  const lon =
    leaf === "lon" ||
    leaf === "longitude" ||
    attrs?.standard_name === "longitude" ||
    String(attrs?.units ?? "").includes("degrees_east");
  return { lat, lon };
}

function sameNames(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

const ds = await indexFromZarr(URL);
const datavar = await ZarrDataManager.getVariableInfo(
  ZarrDataManager.getDatasetSource(ds, VAR),
  VAR,
  ds.zarr_format
);

const gridType = await getGridType(true, VAR, ds, console.error);
console.log("detected grid type:", gridType);
console.log("RR dims:", datavar.dimensionNames, "shape:", datavar.shape);

const spatialDims = (datavar.dimensionNames ?? []).filter(
  (dim) => dim.toLowerCase() !== "time"
);
console.log("expected spatial dims:", spatialDims);

const accepted = { lat: null, lon: null };
for (const [name, source] of Object.entries(ds.levels[0].datasources)) {
  const candidate = isLatLonCandidate(name, source.attrs);
  const reason = [];
  if (!candidate.lat && !candidate.lon) {
    reason.push("not latitude/longitude-like");
  }
  if (candidate.lat || candidate.lon) {
    const dims = source.attrs?.dimensionNames ?? null;
    if (!sameNames(dims, spatialDims)) {
      reason.push(`dimension mismatch ${JSON.stringify(dims)}`);
    } else {
      if (candidate.lat) accepted.lat = name;
      if (candidate.lon) accepted.lon = name;
    }
  }

  if (candidate.lat || candidate.lon || name === "x" || name === "y" || name === "crs") {
    console.log(
      name,
      formatAttrs(source.attrs),
      reason.length ? `rejected: ${reason.join("; ")}` : "accepted"
    );
  }
}

console.log("resolved lat/lon names:", accepted);
const latlon = await getLatLonVariableInfo(datavar, ds, VAR, false);
console.log("lat var dims:", latlon.latitudesVar?.dimensionNames, latlon.latitudesVar?.shape);
console.log("lon var dims:", latlon.longitudesVar?.dimensionNames, latlon.longitudesVar?.shape);
