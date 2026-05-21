import { onBeforeUnmount, shallowRef, watch, type ShallowRef } from "vue";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  HOVERED_GRID_POINT_STATUS,
  useGlobeControlStore,
  type THoveredGridPointStatus,
} from "@/store/store.ts";

export type THoverGeoPoint = {
  lat: number;
  lon: number;
  screenX: number;
  screenY: number;
};

export type TGridHoverLookupResult = {
  lat: number;
  lon: number;
  value: number | null;
  status: THoveredGridPointStatus;
};

export type TGeoSample = {
  lat: number;
  lon: number;
  value: number;
};

export type TGeoSampleIndex = {
  findNearest(lat: number, lon: number): TGeoSample | null;
};

function longitudeDistance(a: number, b: number) {
  const delta = Math.abs(
    ProjectionHelper.normalizeLongitude(a) -
      ProjectionHelper.normalizeLongitude(b)
  );
  return Math.min(delta, 360 - delta);
}

function getBucketKey(latBucket: number, lonBucket: number) {
  return `${latBucket}:${lonBucket}`;
}

function getDistanceScore(
  targetLat: number,
  targetLon: number,
  sample: TGeoSample
) {
  const latDelta = targetLat - sample.lat;
  const meanLatRadians = ((targetLat + sample.lat) / 2 / 180) * Math.PI;
  const lonDelta =
    longitudeDistance(targetLon, sample.lon) * Math.cos(meanLatRadians);
  return latDelta * latDelta + lonDelta * lonDelta;
}

export function createGeoSampleIndex(
  samples: TGeoSample[],
  bucketSizeDegrees = 5
): TGeoSampleIndex {
  const safeBucketSize = Math.max(bucketSizeDegrees, 1);
  const buckets = new Map<string, number[]>();
  const latBucketCount = Math.max(1, Math.ceil(180 / safeBucketSize));
  const lonBucketCount = Math.max(1, Math.ceil(360 / safeBucketSize));

  const getLatBucket = (lat: number) =>
    Math.max(
      0,
      Math.min(
        latBucketCount - 1,
        Math.floor((Math.max(-90, Math.min(90, lat)) + 90) / safeBucketSize)
      )
    );
  const getLonBucket = (lon: number) =>
    ((Math.floor(
      (ProjectionHelper.normalizeLongitude(lon) + 180) / safeBucketSize
    ) %
      lonBucketCount) +
      lonBucketCount) %
    lonBucketCount;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const key = getBucketKey(
      getLatBucket(sample.lat),
      getLonBucket(sample.lon)
    );
    const entries = buckets.get(key);
    if (entries) {
      entries.push(i);
    } else {
      buckets.set(key, [i]);
    }
  }

  return {
    findNearest: (lat, lon) =>
      findNearestInBuckets({
        lat,
        lon,
        samples,
        buckets,
        latBucketCount,
        lonBucketCount,
        getLatBucket,
        getLonBucket,
      }),
  };
}

type BucketSearchContext = {
  lat: number;
  lon: number;
  samples: TGeoSample[];
  buckets: Map<string, number[]>;
  latBucketCount: number;
  lonBucketCount: number;
  getLatBucket: (lat: number) => number;
  getLonBucket: (lon: number) => number;
};

function findNearestInBuckets(ctx: BucketSearchContext): TGeoSample | null {
  const latBucket = ctx.getLatBucket(ctx.lat);
  const lonBucket = ctx.getLonBucket(ctx.lon);
  const visited = new Set<string>();
  const maxRing = Math.max(ctx.latBucketCount, ctx.lonBucketCount);

  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let firstMatchRing = -1;

  for (let ring = 0; ring <= maxRing; ring++) {
    if (firstMatchRing >= 0 && ring > firstMatchRing + 1) {
      break;
    }

    ({ bestIndex, bestScore } = scanRing(
      ctx,
      ring,
      latBucket,
      lonBucket,
      visited,
      bestIndex,
      bestScore
    ));

    if (bestIndex !== -1 && firstMatchRing < 0) {
      firstMatchRing = ring;
    }
  }

  return bestIndex !== -1 ? ctx.samples[bestIndex] : null;
}

function scanRing(
  ctx: BucketSearchContext,
  ring: number,
  latBucket: number,
  lonBucket: number,
  visited: Set<string>,
  bestIndex: number,
  bestScore: number
) {
  for (let latOffset = -ring; latOffset <= ring; latOffset++) {
    for (let lonOffset = -ring; lonOffset <= ring; lonOffset++) {
      if (
        ring > 0 &&
        Math.abs(latOffset) !== ring &&
        Math.abs(lonOffset) !== ring
      ) {
        continue;
      }

      const candidateLatBucket = latBucket + latOffset;
      if (candidateLatBucket < 0 || candidateLatBucket >= ctx.latBucketCount) {
        continue;
      }

      const candidateLonBucket =
        (((lonBucket + lonOffset) % ctx.lonBucketCount) + ctx.lonBucketCount) %
        ctx.lonBucketCount;
      const key = getBucketKey(candidateLatBucket, candidateLonBucket);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      const entries = ctx.buckets.get(key);
      if (!entries) {
        continue;
      }

      for (const sampleIndex of entries) {
        const score = getDistanceScore(
          ctx.lat,
          ctx.lon,
          ctx.samples[sampleIndex]
        );
        if (score < bestScore) {
          bestScore = score;
          bestIndex = sampleIndex;
        }
      }
    }
  }

  return { bestIndex, bestScore };
}

function isMissingGridValue(
  value: number,
  fillValue: number,
  missingValue: number
) {
  return (
    !Number.isFinite(value) || value === fillValue || value === missingValue
  );
}

function createSampleIndexLookup(
  index: TGeoSampleIndex,
  fillValue: number,
  missingValue: number
): (lat: number, lon: number) => TGridHoverLookupResult | null {
  return (lat, lon) => {
    const sample = index.findNearest(lat, lon);
    if (!sample) {
      return null;
    }
    const missing = isMissingGridValue(sample.value, fillValue, missingValue);
    return {
      lat: sample.lat,
      lon: sample.lon,
      value: missing ? null : sample.value,
      status: missing
        ? HOVERED_GRID_POINT_STATUS.MISSING
        : HOVERED_GRID_POINT_STATUS.VALUE,
    };
  };
}

export function useGridHoverLookup(
  hoveredGeoPoint: Readonly<ShallowRef<THoverGeoPoint | null>>
) {
  const store = useGlobeControlStore();
  type HoverLookupFn = (
    lat: number,
    lon: number
  ) => TGridHoverLookupResult | null;
  const lookupRef = shallowRef<HoverLookupFn | null>(null);

  const stopWatch = watch(
    [hoveredGeoPoint, lookupRef] as const,
    ([point, currentLookup]) => {
      if (!point || !currentLookup) {
        store.clearHoveredGridPoint();
        return;
      }

      const result = currentLookup(point.lat, point.lon);
      if (!result) {
        store.clearHoveredGridPoint();
        return;
      }

      store.setHoveredGridPoint({
        ...result,
        screenX: point.screenX,
        screenY: point.screenY,
      });
    }
  );

  onBeforeUnmount(() => {
    stopWatch();
    store.clearHoveredGridPoint();
  });

  return {
    clearHoverLookup() {
      lookupRef.value = null;
    },
    setHoverLookup(nextLookup: HoverLookupFn) {
      lookupRef.value = nextLookup;
    },
    setHoverLookupFromIndex(
      index: TGeoSampleIndex,
      fillValue: number,
      missingValue: number
    ) {
      lookupRef.value = createSampleIndexLookup(index, fillValue, missingValue);
    },
  };
}

/**
 * Create a hover index for regular lat/lon grids.
 *
 * Rather than building a flat sample array and a general bucket index (which
 * allocates O(lat*lon) objects), we store the sorted latitude and longitude
 * axes and the raw data buffer and use binary search on each axis independently.
 * This is O(log(lat) + log(lon)) per lookup and O(lat+lon+data) memory.
 *
 * For rotated grids the caller must supply pre-computed geographic lat/lon
 * as a TGeoSampleIndex (via createGeoSampleIndex) since rotated grids cannot
 * be searched in this way.
 */
export type TRegularGridHoverIndex = {
  lats: Float64Array;
  lons: Float64Array;
  data: Float32Array;
  lonCount: number;
  fillValue: number;
  missingValue: number;
};

function binarySearchNearest(arr: Float64Array, value: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0 && Math.abs(arr[lo - 1] - value) < Math.abs(arr[lo] - value)) {
    return lo - 1;
  }
  return lo;
}

export function createRegularGridHoverIndex(
  lats: Float64Array,
  lons: Float64Array,
  data: Float32Array,
  fillValue: number,
  missingValue: number
): TRegularGridHoverIndex {
  return { lats, lons, data, lonCount: lons.length, fillValue, missingValue };
}

export function setHoverLookupFromRegularIndex(
  index: TRegularGridHoverIndex,
  setHoverLookup: (
    fn: (lat: number, lon: number) => TGridHoverLookupResult | null
  ) => void
) {
  const { lats, lons, data, lonCount, fillValue, missingValue } = index;
  setHoverLookup((lat, lon) => {
    const latIdx = binarySearchNearest(lats, lat);
    // Normalize lon to [0,360) if the lons axis uses that convention, otherwise [-180,180)
    const normalizedLon = lons[0] >= 0 ? ((lon % 360) + 360) % 360 : lon;
    const lonIdx = binarySearchNearest(lons, normalizedLon);
    const value = data[latIdx * lonCount + lonIdx];
    const missing = isMissingGridValue(value, fillValue, missingValue);
    return {
      lat: lats[latIdx],
      lon: ProjectionHelper.normalizeLongitude(lons[lonIdx]),
      value: missing ? null : value,
      status: missing
        ? HOVERED_GRID_POINT_STATUS.MISSING
        : HOVERED_GRID_POINT_STATUS.VALUE,
    };
  });
}
