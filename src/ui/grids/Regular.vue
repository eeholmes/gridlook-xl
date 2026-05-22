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
  createProjectedCoordinateTransformer,
  getDataBounds,
  getLatLonData,
  getProjectedCoordinatesAsLatLon,
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

type TProjectedXYGrid = {
  xCoordinates: Float64Array;
  yCoordinates: Float64Array;
  projection: string;
};

const longitudes = ref<Float64Array>(new Float64Array());
const latitudes = ref<Float64Array>(new Float64Array());
const projectedXYGrid = ref<TProjectedXYGrid | null>(null);

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
  projectedXYGrid.value = null;

  // Handle xy grids that use projected coordinates (e.g. EPSG:3857 with
  // a spatial_ref CRS variable).  Convert x/y to lat/lon before rendering.
  if (isXName(lastDim) && isYName(secondLastDim)) {
    isLatOnly.value = false;
    const projectedCoordinates = await getProjectedCoordinatesAsLatLon(
      props.datasources!,
      varnameSelector.value
    );
    if (projectedCoordinates.displayType === "curvilinear") {
      projectedXYGrid.value = {
        xCoordinates: projectedCoordinates.xCoordinates,
        yCoordinates: projectedCoordinates.yCoordinates,
        projection: projectedCoordinates.projection,
      };
      latitudes.value = new Float64Array();
      longitudes.value = new Float64Array();
      return;
    }

    latitudes.value = projectedCoordinates.latitudes;
    longitudes.value = projectedCoordinates.longitudes;
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

function getGridDimensions() {
  if (projectedXYGrid.value) {
    return {
      latCount: projectedXYGrid.value.yCoordinates.length,
      lonCount: projectedXYGrid.value.xCoordinates.length,
    };
  }
  return {
    latCount: latitudes.value.length,
    lonCount: longitudes.value.length,
  };
}

type TGridGeometryConfig = {
  latCount: number;
  lonCount: number;
  textureLonCount: number;
  isGlobal: boolean;
  isLatReversed: boolean;
  isRotated: boolean;
  latitudeValues: Float64Array;
  longitudeValues: Float64Array;
  projectedGrid: TProjectedXYGrid | null;
  poleLat?: number;
  poleLon?: number;
};

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

function getProjectedGridGeometryConfig(): TGridGeometryConfig {
  const { latCount, lonCount } = getGridDimensions();
  isGridGlobal.value = false;
  return {
    latCount,
    lonCount,
    textureLonCount: lonCount,
    isGlobal: false,
    isLatReversed: false,
    isRotated: false,
    latitudeValues: new Float64Array(),
    longitudeValues: new Float64Array(),
    projectedGrid: projectedXYGrid.value,
  };
}

async function getRegularGridGeometryConfig(): Promise<TGridGeometryConfig> {
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
  return {
    latCount: latitudeValues.length,
    lonCount: longitudeValues.length,
    textureLonCount,
    isGlobal,
    isLatReversed,
    isRotated,
    latitudeValues,
    longitudeValues,
    projectedGrid: null,
    poleLat,
    poleLon,
  };
}

async function getGridGeometryConfig(): Promise<TGridGeometryConfig> {
  if (projectedXYGrid.value) {
    return getProjectedGridGeometryConfig();
  }
  return await getRegularGridGeometryConfig();
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

function getGridVertexLatLon(
  config: TGridGeometryConfig,
  globalLatIndex: number,
  lonIndex: number,
  transformProjectedGrid: ReturnType<
    typeof createProjectedCoordinateTransformer
  > | null
) {
  if (config.projectedGrid && transformProjectedGrid) {
    return transformProjectedGrid(
      config.projectedGrid.xCoordinates[lonIndex],
      config.projectedGrid.yCoordinates[globalLatIndex]
    );
  }
  if (config.isRotated) {
    return rotatedToGeographic(
      config.latitudeValues[globalLatIndex],
      config.longitudeValues[lonIndex],
      config.poleLat!,
      config.poleLon!
    );
  }
  return {
    lat: config.latitudeValues[globalLatIndex],
    lon: config.longitudeValues[lonIndex],
  };
}

function setBatchVertexData(
  config: TGridGeometryConfig,
  globalLatIndex: number,
  lonIndex: number,
  batchPositions: Float32Array,
  batchLatLon: Float32Array,
  batchUvs: Float32Array,
  positionOffset: number,
  latLonOffset: number,
  uvOffset: number,
  transformProjectedGrid: ReturnType<
    typeof createProjectedCoordinateTransformer
  > | null
) {
  const helper = projectionHelper.value;
  const { lat, lon } = getGridVertexLatLon(
    config,
    globalLatIndex,
    lonIndex,
    transformProjectedGrid
  );
  const denominator = Math.max(1, config.latCount - 1);

  helper.projectLatLonToArrays(
    lat,
    lon,
    batchPositions,
    positionOffset,
    batchLatLon,
    latLonOffset
  );
  batchUvs[uvOffset] = (lonIndex + 0.5) / config.textureLonCount;
  batchUvs[uvOffset + 1] = config.isLatReversed
    ? (config.latCount - 1 - globalLatIndex) / denominator
    : globalLatIndex / denominator;
}

function setBatchGeometryAttributes(
  geometry: THREE.BufferGeometry,
  batchPositions: Float32Array,
  batchUvs: Float32Array,
  batchLatLon: Float32Array
) {
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(batchPositions, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(batchUvs, 2));
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(batchLatLon, 2)
  );
}

function createBatchGeometry(
  config: TGridGeometryConfig,
  latStart: number,
  latEnd: number
) {
  const geometry = new THREE.BufferGeometry();
  const { lonCount } = config;

  const batchLatCount = latEnd - latStart + 1;
  const vertexCount = batchLatCount * lonCount;
  const batchPositions = new Float32Array(vertexCount * 3);
  const batchUvs = new Float32Array(vertexCount * 2);
  const batchLatLon = new Float32Array(vertexCount * 2);

  const transformProjectedGrid =
    config.projectedGrid &&
    createProjectedCoordinateTransformer(config.projectedGrid.projection);
  let positionOffset = 0;
  let latLonOffset = 0;
  let uvOffset = 0;

  for (let localLatIndex = 0; localLatIndex < batchLatCount; localLatIndex++) {
    const globalLatIndex = latStart + localLatIndex;
    for (let lonIndex = 0; lonIndex < lonCount; lonIndex++) {
      setBatchVertexData(
        config,
        globalLatIndex,
        lonIndex,
        batchPositions,
        batchLatLon,
        batchUvs,
        positionOffset,
        latLonOffset,
        uvOffset,
        transformProjectedGrid
      );
      positionOffset += 3;
      latLonOffset += 2;
      uvOffset += 2;
    }
  }

  setBatchGeometryAttributes(geometry, batchPositions, batchUvs, batchLatLon);

  // Generate indices for this batch
  const indices = generateGridIndices(batchLatCount, lonCount, config.isGlobal);
  geometry.setIndex(indices);
  return geometry;
}

async function makeGeometry() {
  try {
    const config = await getGridGeometryConfig();
    const { latCount } = config;

    const totalBatches = Math.ceil((latCount - 1) / BATCH_SIZE);
    cleanupMeshes(totalBatches);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const latStart = batchIndex * BATCH_SIZE;
      const latEnd = Math.min(latStart + BATCH_SIZE, latCount - 1);

      const geometry = createBatchGeometry(config, latStart, latEnd);

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
  const { latCount, lonCount } = getGridDimensions();
  const textures = getRegularData(
    rawData,
    latCount,
    lonCount,
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

function buildProjectedHoverSamples(rawData: Float32Array) {
  const samples: { lat: number; lon: number; value: number }[] = [];
  const projectedToGeographic = createProjectedCoordinateTransformer(
    projectedXYGrid.value!.projection
  );
  const latCount = projectedXYGrid.value!.yCoordinates.length;
  const lonCount = projectedXYGrid.value!.xCoordinates.length;

  for (let latIdx = 0; latIdx < latCount; latIdx++) {
    for (let lonIdx = 0; lonIdx < lonCount; lonIdx++) {
      const { lat, lon } = projectedToGeographic(
        projectedXYGrid.value!.xCoordinates[lonIdx],
        projectedXYGrid.value!.yCoordinates[latIdx]
      );
      samples.push({
        lat,
        lon,
        value: rawData[latIdx * lonCount + lonIdx],
      });
    }
  }

  return samples;
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
  if (projectedXYGrid.value) {
    return buildProjectedHoverSamples(rawData);
  }

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
  </div>
</template>
