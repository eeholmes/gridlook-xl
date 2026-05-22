<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
import type * as zarr from "zarrita";

import {
  createGeoSampleIndex,
  useGridHoverLookup,
} from "./composables/gridHoverUtils.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  applyDisplayTransformToData,
  castDataVarToFloat32,
  getDataBounds,
  getCRSStringForXYVariable,
  getLatLonData,
  getXYCoordinatesAsLatLon,
  getXYCoordinatesForPolarDisplay,
  isPolarStereographicCRS,
  isLatitudeName,
  isLongitudeName,
  isXName,
  isYName,
  mapMissingAndFillToNaN,
} from "@/lib/data/zarrUtils.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";
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
  async () => {
    // When polar XY data is loaded, a projection switch may enable or disable
    // rendering; re-run the full datasource update so getDims can re-evaluate
    // the polar/non-polar condition.
    if (isPolarXYData.value || polarProjectionRequired.value) {
      await datasourceUpdate();
    } else {
      updateMeshProjectionUniforms();
    }
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
/** Set when the loaded dataset is a polar stereographic XY grid. */
const isPolarXYData = ref(false);
/**
 * Set when polar XY data is loaded but the active projection is not a polar
 * one.  Triggers the "switch to polar projection" overlay.
 */
const polarProjectionRequired = ref(false);

/** Returns true when the projection mode is a polar flat projection. */
function isPolarProjection(mode: string): boolean {
  return (
    mode === PROJECTION_TYPES.POLAR_NORTH ||
    mode === PROJECTION_TYPES.POLAR_SOUTH
  );
}

/**
 * longitudes, isPolarXYData, and polarProjectionRequired as a side-effect.
 */
async function handleXYGridDims(): Promise<void> {
  const crsStr = await getCRSStringForXYVariable(
    props.datasources!,
    varnameSelector.value
  );
  if (isPolarStereographicCRS(crsStr)) {
    isPolarXYData.value = true;
    if (!isPolarProjection(projectionMode.value)) {
      // Leave latitudes/longitudes empty so makeGeometry is a no-op; the
      // overlay will prompt the user to switch projection.
      polarProjectionRequired.value = true;
      return;
    }
    polarProjectionRequired.value = false;
    const { latitudes: lats, longitudes: lons } =
      await getXYCoordinatesForPolarDisplay(
        props.datasources!,
        varnameSelector.value
      );
    latitudes.value = lats;
    longitudes.value = lons;
    return;
  }
  // Non-polar projected CRS (e.g. EPSG:3857 Web Mercator).
  isPolarXYData.value = false;
  polarProjectionRequired.value = false;
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

  // Handle xy grids that use projected coordinates (e.g. EPSG:3857 or polar
  // stereographic).  Polar datasets require a polar projection to display.
  if (isXName(lastDim) && isYName(secondLastDim)) {
    isLatOnly.value = false;
    await handleXYGridDims();
    return;
  }

  isPolarXYData.value = false;
  polarProjectionRequired.value = false;

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
 * Generates vertices, UVs, and lat/lon coordinates for a grid.
 *
 * For GPU projection, we store lat/lon as vertex attributes and use
 * placeholder positions (0,0,0) that will be computed in the vertex shader.
 * We also compute initial positions for the current projection to avoid
 * a flash of incorrect geometry on first render.
 */
function generateGridVerticesAndUVs(
  latitudes: Float64Array,
  longitudes: Float64Array,
  isReversed: boolean,
  isRotated: boolean,
  textureLonCount: number,
  poleLat?: number,
  poleLon?: number
) {
  const positionValues: number[] = [];
  const uvs: number[] = [];
  const latCount = latitudes.length;
  const lonCount = longitudes.length;
  const latLonValues = new Float32Array(latCount * lonCount * 2);

  const helper = projectionHelper.value;

  for (let i = 0; i < latCount; i++) {
    const rawLat = latitudes[i];
    for (let j = 0; j < lonCount; j++) {
      const rawLon = longitudes[j];

      // If the grid is rotated, convert the raw latitude and longitude values
      // to geographic coordinates.
      const { lat, lon } = isRotated
        ? rotatedToGeographic(rawLat, rawLon, poleLat!, poleLon!)
        : { lat: rawLat, lon: rawLon };

      // Store lat/lon for GPU projection and set initial positions
      const latLonOffset = (i * lonCount + j) * 2;
      const positionOffset = positionValues.length;
      helper.projectLatLonToArrays(
        lat,
        lon,
        positionValues,
        positionOffset,
        latLonValues,
        latLonOffset
      );

      // Calculate the texture coordinates for the point. The `u` coordinate
      // represents the longitude, and the `v` coordinate represents the latitude.
      // The coordinates are normalized to the range [0, 1].
      // Pixel-centre UVs: place each vertex at the centre of its texel so that
      // nearest-neighbour cell boundaries align with the midpoints between data
      // points (fixes the half-cell-east visual shift).
      const u = (j + 0.5) / textureLonCount;
      const v = isReversed
        ? (latCount - 1 - i) / (latCount - 1)
        : i / (latCount - 1);
      uvs.push(u, v);
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

async function getGaussianGrid() {
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
  const { positionValues, uvs, latLonValues } = generateGridVerticesAndUVs(
    latitudeValues,
    longitudeValues,
    isLatReversed,
    isRotated,
    textureLonCount,
    poleLat,
    poleLon
  );

  const latCount = latitudeValues.length;
  const lonCount = longitudeValues.length;

  return {
    positionValues,
    uvs,
    latLonValues,
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
  positionValues: number[],
  uvs: number[],
  latLonValues: Float32Array,
  lonCount: number,
  isGlobal: boolean,
  latStart: number,
  latEnd: number
) {
  const geometry = new THREE.BufferGeometry();

  // Extract vertices for this batch (from latStart to latEnd inclusive)
  const batchLatCount = latEnd - latStart + 1;
  const startVertex = latStart * lonCount;
  const endVertex = (latEnd + 1) * lonCount;

  const batchPositions = positionValues.slice(startVertex * 3, endVertex * 3);
  const batchUvs = uvs.slice(startVertex * 2, endVertex * 2);
  const batchLatLon = latLonValues.slice(startVertex * 2, endVertex * 2);

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(batchPositions, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(batchUvs, 2));
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(batchLatLon, 2)
  );

  // Generate indices for this batch
  const indices = generateGridIndices(batchLatCount, lonCount, isGlobal);
  geometry.setIndex(indices);
  return geometry;
}

async function makeGeometry() {
  try {
    const { positionValues, uvs, latLonValues, latCount, lonCount, isGlobal } =
      await getGaussianGrid();

    const totalBatches = Math.ceil((latCount - 1) / BATCH_SIZE);
    cleanupMeshes(totalBatches);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const latStart = batchIndex * BATCH_SIZE;
      const latEnd = Math.min(latStart + BATCH_SIZE, latCount - 1);

      const geometry = createBatchGeometry(
        positionValues,
        uvs,
        latLonValues,
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

async function buildHoverSamples(rawData: Float32Array) {
  const samples: { lat: number; lon: number; value: number }[] = [];
  let rotPole: { lat: number; lon: number } | null = null;
  if (props.isRotated) {
    rotPole = await getRotatedNorthPole();
  }
  for (let latIdx = 0; latIdx < latitudes.value.length; latIdx++) {
    if (isLatOnly.value) {
      samples.push({
        lat: latitudes.value[latIdx],
        lon: 0,
        value: rawData[latIdx],
      });
    } else {
      for (let lonIdx = 0; lonIdx < longitudes.value.length; lonIdx++) {
        const rawLat = latitudes.value[latIdx];
        const rawLon = longitudes.value[lonIdx];
        const { lat, lon } = rotPole
          ? rotatedToGeographic(rawLat, rawLon, rotPole.lat, rotPole.lon)
          : { lat: rawLat, lon: rawLon };
        samples.push({
          lat,
          lon: ProjectionHelper.normalizeLongitude(lon),
          value: rawData[latIdx * longitudes.value.length + lonIdx],
        });
      }
    }
  }
  return samples;
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
  const samples = await buildHoverSamples(rawData);
  setHoverLookupFromIndex(
    createGeoSampleIndex(samples),
    fillValue,
    missingValue
  );

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
    <div v-if="polarProjectionRequired" class="polar-overlay">
      <div class="polar-overlay-box">
        <p class="polar-overlay-title">Polar stereographic dataset</p>
        <p class="polar-overlay-body">
          This dataset uses a polar stereographic coordinate system. Please
          select
          <strong>Polar (North)</strong> or <strong>Polar (South)</strong> from
          the Projection dropdown to display it.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.polar-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.polar-overlay-box {
  background: rgba(30, 30, 40, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  padding: 1.25rem 1.75rem;
  max-width: 380px;
  text-align: center;
  color: #e8e8f0;
  pointer-events: auto;
}
.polar-overlay-title {
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 0.6rem;
}
.polar-overlay-body {
  font-size: 0.875rem;
  line-height: 1.5;
}
</style>
