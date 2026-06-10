import * as zarr from "zarrita";

import type { TDimensionRange } from "@/lib/types/GlobeTypes.ts";

function setDimensionStart(
  presetStarts: Record<string, string>,
  dimensionName: string,
  minBound: number,
  maxBound: number
) {
  if (
    Object.hasOwn(presetStarts, dimensionName) &&
    !isNaN(Number(presetStarts[dimensionName]))
  ) {
    let startPos = Number(presetStarts[dimensionName]);
    if (startPos < minBound) {
      startPos = minBound;
    }
    if (startPos > maxBound) {
      startPos = maxBound;
    }
    return startPos;
  }
  return 0;
}

function setDimensionMinMaxBounds(
  presetMinBounds: Record<string, string>,
  presetMaxBounds: Record<string, string>,
  dimensionName: string,
  size: number
) {
  let minBound = 0;
  let maxBound = size - 1;
  if (
    Object.hasOwn(presetMinBounds, dimensionName) &&
    !isNaN(Number(presetMinBounds[dimensionName]))
  ) {
    minBound = Number(presetMinBounds[dimensionName]);
  }
  if (
    Object.hasOwn(presetMaxBounds, dimensionName) &&
    !isNaN(Number(presetMaxBounds[dimensionName]))
  ) {
    maxBound = Number(presetMaxBounds[dimensionName]);
  }
  return { minBound, maxBound };
}
/**
 * Creates an array of dimension range objects from a given zarray.
 *
 * The created array will have the same length as the shape of the zarray,
 * minus the last `lastToIgnore` elements. The last `lastToIgnore` elements are
 * ignored and replaced with null values. Null values are used to indicate that
 * all elements of the dimension should be loaded.
 *
 * For each dimension, the following properties are defined:
 * - name: the name of the dimension
 * - startPos: the starting position of the dimension, when loading the data for
 *   the first time
 * - minBound: the minimum bound of the dimension
 * - maxBound: the maximum bound of the dimension
 *
 * The starting position, minimum bound and maximum bound can be overridden
 * by providing preset values in the `presetStarts`, `presetMinBounds` and
 * `presetMaxBounds` objects, respectively. This is done via URL parameters
 *
 * FIXME: The dimensions catched by the lastToIgnore are those of which we
 * expect, that we need to load them completely in order to render the globe.
 * This is e.g. the case for lat and lon-dimensions of a regular grid.
 *
 * In all cases I encountered so far, these dimensions are placed at the end of
 * the dimensions array (hence the lastToIgnore). This is not according to the
 * CF standard, which would sort the dimensions by its size. This might be a
 * problem in the future.
 *
 * @param {zarr.Array<zarr.DataType, zarr.AsyncReadable>} datavar - the zarray to process
 * @param {Record<string, string>} presetStarts - optional preset starting positions
 * @param {Record<string, string>} presetMinBounds - optional preset minimum bounds
 * @param {Record<string, string>} presetMaxBounds - optional preset maximum bounds
 * @returns {TDimensionRange[]} an array of dimension range objects
 */
function createDimensionRanges(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  dimensionNames: string[] | undefined,
  presetStarts: Record<string, string>,
  presetMinBounds: Record<string, string>,
  presetMaxBounds: Record<string, string>,
  indicesToIgnore: number[]
) {
  const shape = datavar.shape;
  const dimensions = dimensionNames || [];
  const indices: TDimensionRange[] = shape.map((size, i) => {
    if (indicesToIgnore.includes(i)) {
      return null;
    }
    const dimensionName = dimensions[i];
    if (size === 1) {
      // Single element dimension
      return { name: dimensionName, startPos: 0, minBound: 0, maxBound: 0 };
    } else {
      const { minBound, maxBound } = setDimensionMinMaxBounds(
        presetMinBounds,
        presetMaxBounds,
        dimensionName,
        size
      );
      const startPos = setDimensionStart(
        presetStarts,
        dimensionName,
        minBound,
        maxBound
      );
      return {
        name: dimensionName,
        startPos,
        minBound,
        maxBound,
      };
    }
  });
  /*
   * IMPORTANT: presetStarts need to be reset outside of this function after use.
   * Otherwise, stale values might persist.
   */
  const keys = Object.keys(presetStarts);
  for (const key of keys) {
    delete presetStarts[key];
  }
  return indices;
}

export function buildDimensionRangesAndIndices(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  dimensionNames: string[] | undefined,
  presetStarts: Record<string, string>,
  presetMinBounds: Record<string, string>,
  presetMaxBounds: Record<string, string>,
  oldSliderValues: (number | null)[] | null,
  indicesToIgnore: number[],
  keepOldValues: boolean
) {
  let dimensionRanges: TDimensionRange[] = [];
  dimensionRanges = createDimensionRanges(
    datavar,
    dimensionNames,
    presetStarts,
    presetMinBounds,
    presetMaxBounds,
    indicesToIgnore
  );
  let indices: (number | null | zarr.Slice)[] = [];
  if (keepOldValues && oldSliderValues !== null) {
    indices = oldSliderValues;
  } else {
    // Initial loading should always start from the displayed slice, not any
    // previously cached slider values from another variable.
    indices = dimensionRanges.map((d) => {
      if (d === null) {
        return null;
      }
      return d.startPos;
    });
  }
  return {
    dimensionRanges,
    indices,
  };
}
