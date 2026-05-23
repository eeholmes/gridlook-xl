<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
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
  posterizeLevels,
  selection,
  isInitializingVariable,
  varinfo,
  projectionMode,
  projectionCenter,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const {
  getScene,
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
const HALF_CIRCLE_DEGREES = 180;
const FULL_CIRCLE_DEGREES = 360;
let meshes: THREE.Mesh[] = [];
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

const bounds = computed(() => {
  return selection.value;
});

watch(
  [
    () => bounds.value,
    () => invertColormap.value,
    () => colormap.value,
    () => posterizeLevels.value,
    () => store.hideLowerBound,
  ],
  () => {
    updateColormap(meshes);
  }
);

watch(
  [() => projectionMode.value, () => projectionCenter.value],
  () => {
    updateMeshProjectionUniforms();
  },
  { deep: true }
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
  if (props.datasources !== undefined) {
    await getDims();
    await Promise.all([makeGeometry(), getData()]);
    updateLandSeaMask();
    updateColormap(meshes);
  }
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
  const latDenominator = Math.max(latitudes.length - 1, 1);

  const helper = projectionHelper.value;

  for (let li = 0; li < batchLatCount; li++) {
    const globalLatIdx = latStart + li;
    const rawLat = latitudes[globalLatIdx];
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
      const u = (lj + 0.5) / textureLonCount;
      const v = isReversed
        ? (latitudes.length - 1 - globalLatIdx) / latDenominator
        : globalLatIdx / latDenominator;
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
  const indices: number[] = [];
  const latIterationEnd = latCount - 1;
  const lonIterationEnd = isGlobal ? lonCount : lonCount - 1;

  for (let latIt = 0; latIt < latIterationEnd; latIt++) {
    for (let lonIt = 0; lonIt < lonIterationEnd; lonIt++) {
      const nextJ = isGlobal ? (lonIt + 1) % lonCount : lonIt + 1;
      const lowLeft = latIt * lonCount + lonIt;
      const lowRight = latIt * lonCount + nextJ;
      const topLeft = (latIt + 1) * lonCount + lonIt;
      const topRight = (latIt + 1) * lonCount + nextJ;

      indices.push(lowLeft, topRight, topLeft);
      indices.push(lowLeft, lowRight, topRight);
    }
  }

  return indices;
}

function normalizeLongitudes(longitudes: Float64Array): Float64Array {
  // Normalize longitudes to [0, 360)
  return Float64Array.from(longitudes, (lon) => ((lon % 360) + 360) % 360);
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

  if (isGlobal) {
    // Add a duplicate of the first longitude + 360 to close the globe
    const firstLon = longitudeValues[0];
    longitudeValues = new Float64Array([...longitudeValues, firstLon + 360]);
  }

  let poleLat, poleLon;
  if (isRotated) {
    const rotatedNorthPole = await getRotatedNorthPole();
    poleLat = rotatedNorthPole.lat;
    poleLon = rotatedNorthPole.lon;
  }
  const latCount = latitudeValues.length;
  const lonCount = longitudeValues.length;

  return {
    latitudeValues,
    longitudeValues,
    textureLonCount,
    isLatReversed,
    isRotated,
    poleLat,
    poleLon,
    latCount,
    lonCount,
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
  latitudeValues: Float64Array,
  longitudeValues: Float64Array,
  textureLonCount: number,
  isLatReversed: boolean,
  isRotated: boolean,
  poleLat: number | undefined,
  poleLon: number | undefined,
  lonCount: number,
  isGlobal: boolean,
  latStart: number,
  latEnd: number
) {
  const geometry = new THREE.BufferGeometry();

  const batchLatCount = latEnd - latStart + 1;
  const { positionValues, uvs, latLonValues } = generateBatchGeometryData(
    latitudeValues,
    longitudeValues,
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

  // Generate indices for this batch
  const indices = generateGridIndices(batchLatCount, lonCount, isGlobal);
  geometry.setIndex(indices);
  return geometry;
}

async function makeGeometry() {
  try {
    const {
      latitudeValues,
      longitudeValues,
      textureLonCount,
      isLatReversed,
      isRotated,
      poleLat,
      poleLon,
      latCount,
      lonCount,
      isGlobal,
    } = await getRegularGridParameters();

    const totalBatches = Math.ceil((latCount - 1) / BATCH_SIZE);
    cleanupMeshes(totalBatches);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const latStart = batchIndex * BATCH_SIZE;
      const latEnd = Math.min(latStart + BATCH_SIZE, latCount - 1);

      const geometry = createBatchGeometry(
        latitudeValues,
        longitudeValues,
        textureLonCount,
        isLatReversed,
        isRotated,
        poleLat,
        poleLon,
        lonCount,
        isGlobal,
        latStart,
        latEnd
      );

      if (meshes[batchIndex]) {
        meshes[batchIndex].geometry.dispose();
        meshes[batchIndex].geometry = geometry;
      } else {
        const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial());
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
  const texture = new THREE.DataTexture(
    data,
    lonCount,
    latCount,
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
  const low = bounds.value?.low as number;
  const high = bounds.value?.high as number;
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

  const { missingValue, fillValue } = getDataBounds(datavar, rawData);
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
