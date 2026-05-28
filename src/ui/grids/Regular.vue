<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onUnmounted, ref, watch } from "vue";
import type * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import type { TGeoSampleIndex } from "./composables/gridHoverUtils.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  applyDisplayTransformToData,
  castDataVarToFloat32,
  getDataBounds,
  getLatLonData,
  getMissingAndFillValues,
  getXYCoordinatesAsLatLon,
  isLatitudeName,
  isLongitudeName,
  isXName,
  isYName,
  mapMissingAndFillToNaN,
} from "@/lib/data/zarrUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  getColormapScaleOffset,
  makeGpuProjectedTextureMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const props = defineProps<{
  datasources?: TSources;
  isRotated?: boolean;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  dimSlidersValues,
  colormap,
  transformMode,
  varnameSelector,
  invertColormap,
  selection,
  isInitializingVariable,
  varinfo,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const {
  getScene,
  getRenderer,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  resetDataVars,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  updateHistogram,
  projectionHelper,
  onProjectionChange,
  onMotionStateChange,
  onColormapChange,
  canvas,
  box,
  hoveredGeoPoint,
} = useSharedGridLogic();

const pendingUpdate = ref(false);
const updatingData = ref(false);

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

const longitudes = ref(new Float64Array());
const latitudes = ref(new Float64Array());

const BATCH_SIZE = 60;
// Maximum number of geometry vertices per lat/lon axis. Large grids are
// subsampled so makeGeometry stays fast; the full-resolution data texture
// is unaffected and provides the actual rendering detail.
const MAX_GEO_RESOLUTION = 512;
const HALF_CIRCLE_DEGREES = 180;
const FULL_CIRCLE_DEGREES = 360;
let meshes: THREE.Mesh[] = [];
const loadingMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  side: THREE.DoubleSide,
});

onColormapChange(() => {
  updateColormap(meshes);
});

onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);
watch(
  () => varnameSelector.value,
  async (nextVarname, previousVarname) => {
    if (nextVarname === previousVarname) {
      return;
    }
    await datasourceUpdate();
  }
);

watch(
  () => transformMode.value,
  () => {
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  async () => {
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    await getData(UPDATE_MODE.SLIDER_TOGGLE);
    updateColormap(meshes);
  },
  { deep: true }
);

watch(
  () => props.datasources,
  () => {
    datasourceUpdate();
  }
);

function updateMeshProjectionUniforms() {
  const helper = projectionHelper.value;
  for (const mesh of meshes) {
    const material = mesh.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(material, helper);
    }
  }
  redraw();
}

async function datasourceUpdate() {
  resetDataVars();
  clearHoverLookup();
  setMeshesLoadingState();
  if (props.datasources !== undefined) {
    await getDims();
    await makeGeometry();
    await getData();
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

function setMeshesLoadingState() {
  if (meshes.length === 0) {
    return;
  }
  const materialsToDispose = new Set<THREE.Material>();
  for (const mesh of meshes) {
    const previousMaterial = mesh.material;
    if (Array.isArray(previousMaterial)) {
      for (const material of previousMaterial) {
        if (material !== loadingMaterial) {
          materialsToDispose.add(material);
        }
      }
    } else if (previousMaterial !== loadingMaterial) {
      materialsToDispose.add(previousMaterial);
    }
    mesh.material = loadingMaterial;
  }
  for (const material of materialsToDispose) {
    material.dispose();
  }
  redraw();
}

const isLatOnly = ref(false);
const isGridGlobal = ref(false);

/**
 * Handles projected x/y coordinate grids inside getDims.
 * Currently only supports Web Mercator (EPSG:3857).
 * Polar stereographic datasets are routed to Curvilinear.vue instead.
 */
async function handleXYGridDims(): Promise<void> {
  const { latitudes: lats, longitudes: lons } = await getXYCoordinatesAsLatLon(
    props.datasources!,
    varnameSelector.value
  );
  latitudes.value = lats;
  longitudes.value = lons;
}

async function getDims() {
  const datavar = await getDataVar(varnameSelector.value, props.datasources!);
  if (!datavar) {
    return;
  }

  // Assumptions: the last two dimensions of the data array are
  // latitude and longitude (in this order), or lat-only for zonally averaged data
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );

  const lastDim = dimensions[dimensions.length - 1];
  const secondLastDim = dimensions[dimensions.length - 2];

  // Handle xy grids that use projected coordinates (e.g. EPSG:3857 Web Mercator).
  // Polar stereographic datasets are routed to Curvilinear.vue by the grid
  // type detector, so they will not reach this code path.
  if (isXName(lastDim) && isYName(secondLastDim)) {
    isLatOnly.value = false;
    await handleXYGridDims();
    return;
  }

  const latOnlyCheck =
    isLatitudeName(lastDim) && !isLongitudeName(secondLastDim);
  isLatOnly.value = latOnlyCheck;

  const { latitudes: latitudeChunk, longitudes: longitudeChunk } =
    await getLatLonData(datavar, props.datasources, varnameSelector.value);

  latitudes.value = new Float64Array(latitudeChunk.data as Float64Array);
  if (!longitudeChunk) {
    longitudes.value = Float64Array.from({ length: 360 }, (_, i) => i - 179.5);
    return;
  }

  longitudes.value = new Float64Array(longitudeChunk.data as Float64Array);
}

function rotatedToGeographic(
  latR: number,
  lonR: number,
  poleLat: number,
  poleLon: number
) {
  const latRRad = THREE.MathUtils.degToRad(latR);
  const lonRRad = THREE.MathUtils.degToRad(lonR);
  const poleLatRad = THREE.MathUtils.degToRad(poleLat);
  const poleLonRad = THREE.MathUtils.degToRad(poleLon);

  const sinPhi =
    Math.sin(poleLatRad) * Math.sin(latRRad) +
    Math.cos(poleLatRad) * Math.cos(latRRad) * Math.cos(lonRRad);
  const phi = Math.asin(sinPhi);

  const y = -Math.cos(latRRad) * Math.sin(lonRRad);
  const x =
    Math.sin(latRRad) * Math.cos(poleLatRad) -
    Math.cos(latRRad) * Math.sin(poleLatRad) * Math.cos(lonRRad);
  const lambda = poleLonRad + Math.atan2(y, x);

  // Normalize longitude to [-180, 180)
  let lon = THREE.MathUtils.radToDeg(lambda);
  if (lon > 180) {
    lon -= 360;
  }
  if (lon < -180) {
    lon += 360;
  }

  const lat = THREE.MathUtils.radToDeg(phi);
  return { lat, lon };
}

function isLongitudeGlobal(longitudes: Float64Array): boolean {
  const n = longitudes.length;
  if (n < 2) {
    return false;
  }

  // Use unwrapped longitudes to check span
  const span = Math.abs(longitudes[n - 1] - longitudes[0]);

  // Estimate the grid spacing
  const avgDelta = span / (n - 1);

  // Check if span + one grid cell covers 360°
  return span + avgDelta > 359.5;
}

/**
 * Generates vertices, UVs, and lat/lon coordinates for one latitude batch.
 * `latStart` and `latEnd` are global latitude row indices into `latitudes`.
 */
function generateBatchGeometryData(
  latitudes: Float64Array,
  longitudes: Float64Array,
  latOrigIndices: Int32Array,
  lonOrigIndices: Int32Array,
  originalLatCount: number,
  latStart: number,
  latEnd: number,
  isReversed: boolean,
  isRotated: boolean,
  textureLonCount: number,
  poleLat?: number,
  poleLon?: number
) {
  const batchLatCount = latEnd - latStart + 1;
  const lonCount = longitudes.length;
  const vertexCount = batchLatCount * lonCount;
  const positionValues = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const latLonValues = new Float32Array(vertexCount * 2);
  // UV v spans the full source texture latitude range, so we normalize
  // against total latitude count instead of only this batch size.
  const latDenominator = Math.max(originalLatCount - 1, 1);

  const helper = projectionHelper.value;

  for (let li = 0; li < batchLatCount; li++) {
    const globalLatIdx = latStart + li;
    const rawLat = latitudes[globalLatIdx];
    // Original lat index in the (possibly reversed) full-resolution array,
    // used to compute the correct UV v coordinate into the data texture.
    const latOrigIdx = latOrigIndices[globalLatIdx];
    for (let lj = 0; lj < lonCount; lj++) {
      const rawLon = longitudes[lj];

      // If the grid is rotated, convert the raw latitude and longitude values
      // to geographic coordinates.
      const { lat, lon } = isRotated
        ? rotatedToGeographic(rawLat, rawLon, poleLat!, poleLon!)
        : { lat: rawLat, lon: rawLon };

      // Store lat/lon for GPU projection and set initial positions
      const vertexIdx = li * lonCount + lj;
      helper.projectLatLonToArrays(
        lat,
        lon,
        positionValues,
        vertexIdx * 3,
        latLonValues,
        vertexIdx * 2
      );

      // Calculate the texture coordinates for the point. The `u` coordinate
      // represents the longitude, and the `v` coordinate represents the latitude.
      // The coordinates are normalized to the range [0, 1].
      // Pixel-centre UVs: place each vertex at the centre of its texel so that
      // nearest-neighbour cell boundaries align with the midpoints between data
      // points (fixes the half-cell-east visual shift).
      const u = (lonOrigIndices[lj] + 0.5) / textureLonCount;
      const v = isReversed
        ? (originalLatCount - 1 - latOrigIdx) / latDenominator
        : latOrigIdx / latDenominator;
      uvs[vertexIdx * 2] = u;
      uvs[vertexIdx * 2 + 1] = v;
    }
  }

  return { positionValues, uvs, latLonValues };
}

function generateGridIndices(
  latCount: number,
  lonCount: number,
  isGlobal: boolean
) {
  const latIterationEnd = latCount - 1;
  const lonIterationEnd = isGlobal ? lonCount : lonCount - 1;
  const numIndices = latIterationEnd * lonIterationEnd * 6;
  const indices = new Uint32Array(numIndices);
  let i = 0;
  for (let latIt = 0; latIt < latIterationEnd; latIt++) {
    for (let lonIt = 0; lonIt < lonIterationEnd; lonIt++) {
      const nextJ = isGlobal ? (lonIt + 1) % lonCount : lonIt + 1;
      const lowLeft = latIt * lonCount + lonIt;
      const lowRight = latIt * lonCount + nextJ;
      const topLeft = (latIt + 1) * lonCount + lonIt;
      const topRight = (latIt + 1) * lonCount + nextJ;

      indices[i++] = lowLeft;
      indices[i++] = topRight;
      indices[i++] = topLeft;
      indices[i++] = lowLeft;
      indices[i++] = lowRight;
      indices[i++] = topRight;
    }
  }

  return indices;
}

function normalizeLongitudes(longitudes: Float64Array): Float64Array {
  // Normalize longitudes to [0, 360)
  return Float64Array.from(longitudes, (lon) => ((lon % 360) + 360) % 360);
}

/**
 * Subsample a coordinate array to at most `maxVerts` vertices, selecting
 * indices distributed linearly from first to last.  Returns the subsampled
 * coordinate values and the corresponding original indices so that UV
 * coordinates can be mapped back to the full-resolution data texture.
 * When the array is already small enough, it is returned unchanged with a
 * trivial identity index map (no copy).
 */
function subsampleCoords(
  arr: Float64Array,
  maxVerts: number
): { coords: Float64Array; origIndices: Int32Array } {
  if (arr.length <= maxVerts || maxVerts <= 1) {
    const origIndices = new Int32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      origIndices[i] = i;
    }
    return { coords: arr, origIndices };
  }
  const coords = new Float64Array(maxVerts);
  const origIndices = new Int32Array(maxVerts);
  for (let i = 0; i < maxVerts; i++) {
    const j = Math.round((i * (arr.length - 1)) / (maxVerts - 1));
    origIndices[i] = j;
    coords[i] = arr[j];
  }
  return { coords, origIndices };
}

/**
 * Computes normalized/rotation-aware grid coordinate parameters used
 * to build regular-grid render geometry batches.
 */
async function getRegularGridParameters() {
  const isRotated = props.isRotated;
  let longitudeValues = normalizeLongitudes(longitudes.value);
  let latitudeValues = latitudes.value;

  // Check if latitudes are descending and reverse if necessary
  let isLatReversed =
    latitudeValues[0] > latitudeValues[latitudeValues.length - 1];
  if (isLatReversed) {
    latitudeValues = Float64Array.from(latitudeValues).reverse();
  }

  const isGlobal = isLongitudeGlobal(longitudes.value);
  isGridGlobal.value = isGlobal;
  // Save original count before the global wrap-around vertex is appended;
  // the texture has only this many pixels in the longitude direction.
  const textureLonCount = longitudeValues.length;
  const originalLatCount = latitudeValues.length;

  // Subsample lat/lon for the geometry mesh when the grid is very large.
  // The data texture retains full resolution; subsampled vertices store their
  // original indices so UV coordinates are mapped correctly to the texture.
  const { coords: geoLats, origIndices: latOrigIndices } = subsampleCoords(
    latitudeValues,
    MAX_GEO_RESOLUTION
  );
  const { coords: geoLonsPre, origIndices: lonOrigIndicesPre } =
    subsampleCoords(longitudeValues, MAX_GEO_RESOLUTION);

  // Build geo longitude array with optional global wrap vertex, and extend the
  // orig-indices array with a sentinel (textureLonCount) for the wrap vertex so
  // that its UV u lands just past 1.0 and RepeatWrapping samples pixel 0.
  let geoLongitudes: Float64Array;
  let lonOrigIndices: Int32Array;
  if (isGlobal) {
    geoLongitudes = new Float64Array([...geoLonsPre, geoLonsPre[0] + 360]);
    lonOrigIndices = new Int32Array(lonOrigIndicesPre.length + 1);
    lonOrigIndices.set(lonOrigIndicesPre);
    lonOrigIndices[lonOrigIndicesPre.length] = textureLonCount;
  } else {
    geoLongitudes = geoLonsPre;
    lonOrigIndices = lonOrigIndicesPre;
  }

  let poleLat: number | undefined, poleLon: number | undefined;
  if (isRotated) {
    ({ lat: poleLat, lon: poleLon } = await getRotatedNorthPole());
  }

  return {
    geoLatitudes: geoLats,
    geoLongitudes,
    latOrigIndices,
    lonOrigIndices,
    originalLatCount,
    textureLonCount,
    isLatReversed,
    isRotated,
    poleLat,
    poleLon,
    geoLatCount: geoLats.length,
    geoLonCount: geoLongitudes.length,
    isGlobal,
  };
}

function cleanupMeshes(totalBatches: number) {
  if (meshes.length <= totalBatches) {
    return;
  }
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    getScene()?.remove(mesh);
  }
  meshes.length = 0;
}

function createBatchGeometry(
  geoLatitudes: Float64Array,
  geoLongitudes: Float64Array,
  latOrigIndices: Int32Array,
  lonOrigIndices: Int32Array,
  originalLatCount: number,
  textureLonCount: number,
  isLatReversed: boolean,
  isRotated: boolean,
  poleLat: number | undefined,
  poleLon: number | undefined,
  geoLonCount: number,
  isGlobal: boolean,
  latStart: number,
  latEnd: number
) {
  const geometry = new THREE.BufferGeometry();

  const batchLatCount = latEnd - latStart + 1;
  const { positionValues, uvs, latLonValues } = generateBatchGeometryData(
    geoLatitudes,
    geoLongitudes,
    latOrigIndices,
    lonOrigIndices,
    originalLatCount,
    latStart,
    latEnd,
    isLatReversed,
    isRotated,
    textureLonCount,
    poleLat,
    poleLon
  );

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positionValues, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(latLonValues, 2)
  );

  // Generate indices for this batch; wrap in a BufferAttribute so THREE.js
  // uses the typed array directly without re-allocating.
  const indices = generateGridIndices(batchLatCount, geoLonCount, isGlobal);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

async function makeGeometry() {
  try {
    const p = await getRegularGridParameters();

    const totalBatches = Math.ceil((p.geoLatCount - 1) / BATCH_SIZE);
    cleanupMeshes(totalBatches);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const latStart = batchIndex * BATCH_SIZE;
      const latEnd = Math.min(latStart + BATCH_SIZE, p.geoLatCount - 1);

      const geometry = createBatchGeometry(
        p.geoLatitudes,
        p.geoLongitudes,
        p.latOrigIndices,
        p.lonOrigIndices,
        p.originalLatCount,
        p.textureLonCount,
        p.isLatReversed,
        p.isRotated,
        p.poleLat,
        p.poleLon,
        p.geoLonCount,
        p.isGlobal,
        latStart,
        latEnd
      );

      if (meshes[batchIndex]) {
        meshes[batchIndex].geometry.dispose();
        meshes[batchIndex].geometry = geometry;
      } else {
        const mesh = new THREE.Mesh(geometry, loadingMaterial);
        mesh.frustumCulled = false;
        meshes.push(mesh);
        getScene()?.add(mesh);
      }
    }
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

/**
 * Downsample a flat 2-D Float32 data array from (srcWidth × srcHeight) to
 * (dstWidth × dstHeight) using nearest-neighbour resampling.  NaN values are
 * preserved so the colormap shader can still mask missing data correctly.
 * Both dst dimensions must be ≥ 2 (ensured by the caller capping at maxTexSize).
 */
function downsampleDataTexture(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Float32Array {
  const dst = new Float32Array(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y++) {
    const srcY = Math.round((y * (srcHeight - 1)) / (dstHeight - 1));
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.round((x * (srcWidth - 1)) / (dstWidth - 1));
      dst[y * dstWidth + x] = src[srcY * srcWidth + srcX];
    }
  }
  return dst;
}

function getRegularData(
  arr: Float32Array,
  latCount: number,
  lonCount: number,
  wrapRepeat: boolean
) {
  let data = arr;
  // For lat-only data, tile it across all longitudes
  if (isLatOnly.value) {
    data = new Float32Array(latCount * lonCount);
    for (let lat = 0; lat < latCount; lat++) {
      for (let lon = 0; lon < lonCount; lon++) {
        data[lat * lonCount + lon] = arr[lat];
      }
    }
  }

  // Clamp texture dimensions to the GPU's maxTextureSize.  Mobile GPUs often
  // cap at 4096 pixels per side; textures larger than that are silently broken
  // (every texel reads as 0), causing the globe to show only the zero-value
  // colour.  Nearest-neighbour downsampling keeps the same UV mapping because
  // the UVs already range over [0, 1] and map correctly at any resolution.
  const maxTexSize = getRenderer()?.capabilities.maxTextureSize ?? 4096;
  let texWidth = lonCount;
  let texHeight = latCount;
  if (texWidth > maxTexSize || texHeight > maxTexSize) {
    texWidth = Math.min(lonCount, maxTexSize);
    texHeight = Math.min(latCount, maxTexSize);
    data = downsampleDataTexture(data, lonCount, latCount, texWidth, texHeight);
  }

  const texture = new THREE.DataTexture(
    data,
    texWidth,
    texHeight,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  if (wrapRepeat) {
    // Global grids append a wrap vertex with UV > 1; RepeatWrapping makes it
    // sample pixel 0 instead of clamping to the last pixel.
    texture.wrapS = THREE.RepeatWrapping;
  }
  texture.needsUpdate = true;
  return texture;
}

async function getRotatedNorthPole(): Promise<{ lat: number; lon: number }> {
  const crs = await ZarrDataManager.getCRSInfo(
    props.datasources!,
    varnameSelector.value
  );
  const lat = crs.attrs["grid_north_pole_latitude"] as number;
  const lon = crs.attrs["grid_north_pole_longitude"] as number;
  return { lat, lon };
}

function makeMaterial(rawData: Float32Array) {
  const textures = getRegularData(
    rawData,
    latitudes.value.length,
    longitudes.value.length,
    isGridGlobal.value
  );
  const low = selection.value?.low as number;
  const high = selection.value?.high as number;
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    low,
    high,
    invertColormap.value
  );

  // Use GPU-projected material for instant projection center changes
  return makeGpuProjectedTextureMaterial(
    textures,
    colormap.value,
    addOffset,
    scaleFactor
  );
}

async function getDimensionValues(
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  const dimValues = await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );
  return dimValues;
}

/**
 * Builds a regular-grid hover index using binary search over lat/lon axes,
 * avoiding full sample materialization for each data refresh.
 */
async function buildHoverIndex(
  rawData: Float32Array
): Promise<TGeoSampleIndex> {
  let rotPole: { lat: number; lon: number } | null = null;
  if (props.isRotated) {
    rotPole = await getRotatedNorthPole();
  }

  const lats = latitudes.value;
  const lons = longitudes.value;
  const latCount = lats.length;
  const lonCount = lons.length;

  return {
    findNearest(queryLat: number, queryLon: number) {
      if (latCount === 0 || lonCount === 0) {
        return null;
      }

      const latIdx = nearestIndex(lats, queryLat);
      if (latIdx < 0) {
        return null;
      }
      if (isLatOnly.value) {
        return { lat: lats[latIdx], lon: 0, value: rawData[latIdx] };
      }

      const lonIdx = nearestLonIndex(lons, queryLon);
      if (lonIdx < 0) {
        return null;
      }
      const rawLat = lats[latIdx];
      const rawLon = lons[lonIdx];
      const { lat, lon } = rotPole
        ? rotatedToGeographic(rawLat, rawLon, rotPole.lat, rotPole.lon)
        : { lat: rawLat, lon: rawLon };

      return {
        lat,
        lon: ProjectionHelper.normalizeLongitude(lon),
        value: rawData[latIdx * lonCount + lonIdx],
      };
    },
  };
}

/**
 * Finds nearest index in a sorted (ascending or descending) 1D array.
 */
function nearestIndex(sorted: Float64Array, target: number): number {
  if (sorted.length === 0) {
    return -1;
  }
  if (sorted.length === 1) {
    return 0;
  }

  let lo = 0;
  let hi = sorted.length - 1;
  const ascending = sorted[0] < sorted[hi];

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ascending ? sorted[mid] < target : sorted[mid] > target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  if (
    lo > 0 &&
    Math.abs(sorted[lo - 1] - target) < Math.abs(sorted[lo] - target)
  ) {
    return lo - 1;
  }
  return lo;
}

/**
 * Finds nearest longitude index with wrap-aware fallback across antimeridian.
 */
function nearestLonIndex(lons: Float64Array, target: number): number {
  if (lons.length === 0) {
    return -1;
  }
  if (lons.length === 1) {
    return 0;
  }

  const lo = lons[0];
  const hi = lons[lons.length - 1];

  let adjustedTarget = target;
  if (adjustedTarget < lo - HALF_CIRCLE_DEGREES) {
    adjustedTarget += FULL_CIRCLE_DEGREES;
  } else if (adjustedTarget > hi + HALF_CIRCLE_DEGREES) {
    adjustedTarget -= FULL_CIRCLE_DEGREES;
  }

  const idx = nearestIndex(lons, adjustedTarget);
  // Choose wrapped alternative direction based on which side of the longitude
  // range midpoint the adjusted target falls on.
  const altTarget =
    adjustedTarget < (lo + hi) / 2
      ? adjustedTarget + FULL_CIRCLE_DEGREES
      : adjustedTarget - FULL_CIRCLE_DEGREES;
  const altIdx = nearestIndex(lons, altTarget);

  const dist = Math.abs(lons[idx] - adjustedTarget);
  let altDist = Math.abs(lons[altIdx] - altTarget);
  // Normalize wrapped distance when the alternative crosses the antimeridian.
  if (altDist > HALF_CIRCLE_DEGREES) {
    altDist = FULL_CIRCLE_DEGREES - altDist;
  }
  return dist <= altDist ? idx : altIdx;
}

async function buildDimensionConfig(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  updateMode: TUpdateMode
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const excludedDims = isLatOnly.value
    ? [datavar.shape.length - 1]
    : [datavar.shape.length - 2, datavar.shape.length - 1];
  return buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    excludedDims,
    varinfo.value?.dimRanges,
    updateMode === UPDATE_MODE.SLIDER_TOGGLE
  );
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  updateMode: TUpdateMode
) {
  const { dimensionRanges, indices } = await buildDimensionConfig(
    datavar,
    updateMode
  );

  let rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );

  const { missingValue, fillValue } = getMissingAndFillValues(datavar);
  rawData = mapMissingAndFillToNaN(rawData, missingValue, fillValue);
  rawData = applyDisplayTransformToData(rawData, transformMode.value);
  const { min, max } = getDataBounds(datavar, rawData);

  const material = makeMaterial(rawData);

  // Set initial projection uniforms
  const helper = projectionHelper.value;
  updateProjectionUniforms(material, helper);

  // Update hover lookup
  const hoverIndex = await buildHoverIndex(rawData);
  setHoverLookupFromIndex(hoverIndex, fillValue, missingValue);

  updateHistogram(rawData, min, max, missingValue, fillValue);

  for (const mesh of meshes) {
    mesh.material = material;
    mesh.material.needsUpdate = true;
  }

  const dimInfo = await getDimensionValues(dimensionRanges, indices);

  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
      bounds: { low: min, high: max },
      dimRanges: dimensionRanges,
    },
    indices as number[],
    updateMode
  );
  redraw();
}

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
  store.startLoading();
  if (updatingData.value) {
    pendingUpdate.value = true;
    return;
  }

  try {
    do {
      pendingUpdate.value = false;
      updatingData.value = true;

      const localVarname = varnameSelector.value;

      const datavar = await getDataVar(localVarname, props.datasources!);

      if (datavar !== undefined) {
        await fetchAndRenderData(datavar, updateMode);
      }
      updatingData.value = false;
    } while (pendingUpdate.value);
  } catch (error) {
    logError(error, "Could not fetch data");
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onUnmounted(() => {
  loadingMaterial.dispose();
});

defineExpose({
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
