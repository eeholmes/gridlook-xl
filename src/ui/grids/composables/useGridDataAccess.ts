import type { ShallowRef } from "vue";
import { shallowRef } from "vue";
import * as zarr from "zarrita";

import { decodeTime } from "@/lib/data/timeHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type {
  TDataSource,
  TDimensionRange,
  TSources,
  TDimInfo,
} from "@/lib/types/GlobeTypes.ts";
import { useLog } from "@/utils/logging.ts";

type TCoordinateValue = number | bigint | string;

/* eslint-disable-next-line max-lines-per-function */
export function useGridDataAccess() {
  const { logError, logWarning } = useLog();
  const datavars: ShallowRef<
    Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
  > = shallowRef({});
  const warnedUnsupportedCoordinates = new Set<string>();

  async function isUnsupportedCoordinateDataType(
    datasource: TDataSource,
    dimensionName: string
  ) {
    return await ZarrDataManager.hasUnsupportedV3ObjectDataType(
      datasource,
      dimensionName
    );
  }

  function warnUnsupportedCoordinateOnce(
    datasource: TDataSource,
    dimensionName: string
  ) {
    const warningKey = `${datasource.store}|${datasource.dataset}|${dimensionName}`;
    if (warnedUnsupportedCoordinates.has(warningKey)) {
      return;
    }
    warnedUnsupportedCoordinates.add(warningKey);
    logWarning(
      `Skipping coordinate '${dimensionName}' because Zarr v3 object-style data_type is not yet supported.`,
      "Unsupported coordinate metadata"
    );
  }

  function warnTimeCoordinateFallbackOnce(datasource: TDataSource) {
    const warningKey = `${datasource.store}|${datasource.dataset}|time_fallback`;
    if (warnedUnsupportedCoordinates.has(warningKey)) {
      return;
    }
    warnedUnsupportedCoordinates.add(warningKey);
    logWarning(
      "Using index-based fallback values for coordinate 'time' because Zarr v3 object-style data_type is not yet supported.",
      "Unsupported coordinate metadata"
    );
  }

  async function getTimeIndexFallbackInfo(
    datasource: TDataSource,
    index: number
  ): Promise<TDimInfo> {
    const metadata = await ZarrDataManager.getVariableMetadata(
      datasource,
      "time"
    );
    const timeLength = metadata?.shape?.[0];
    if (
      typeof timeLength !== "number" ||
      !Number.isInteger(timeLength) ||
      timeLength <= 0
    ) {
      return {};
    }

    const values = Int32Array.from({ length: timeLength }, (_, i) => i);
    const boundedIndex = Math.max(0, Math.min(index, values.length - 1));
    warnTimeCoordinateFallbackOnce(datasource);
    return {
      values,
      current: values[boundedIndex],
      attrs: (metadata?.attributes ?? metadata?.attrs ?? {}) as zarr.Attributes,
    };
  }

  function getCoordinateValues(
    rawValues: zarr.Chunk<zarr.DataType>["data"],
    index: number
  ) {
    if (
      rawValues instanceof zarr.UnicodeStringArray ||
      rawValues instanceof zarr.ByteStringArray
    ) {
      const stringValues = [...rawValues];
      return {
        dimValues: stringValues as ArrayLike<TCoordinateValue>,
        current: stringValues[index] as TCoordinateValue,
      };
    }
    const numericValues = rawValues as ArrayLike<TCoordinateValue>;
    return {
      dimValues: numericValues,
      current: numericValues[index] as TCoordinateValue,
    };
  }

  function resetDataVars() {
    datavars.value = {};
  }

  async function getDataVar(myVarname: string, datasources: TSources) {
    const myDatasource = datasources?.levels[0]?.datasources[myVarname];
    if (!myDatasource) {
      return undefined;
    }
    try {
      const datavar = await ZarrDataManager.getVariableInfoByDatasetSources(
        datasources!,
        myVarname
      );
      return datavar;
    } catch (error) {
      logError(
        error,
        `Couldn't fetch variable ${myVarname} from store: ${myDatasource.store} and dataset: ${myDatasource.dataset}`
      );
      return undefined;
    }
  }

  async function getTimeInfo(
    datasources: TSources,
    dimensionRanges: TDimensionRange[],
    dimensionIndex: number,
    index: number
  ): Promise<TDimInfo> {
    if (dimensionRanges[dimensionIndex]?.name !== "time") {
      return {};
    }
    try {
      const myDatasource = datasources!.levels[0].time;
      if (await isUnsupportedCoordinateDataType(myDatasource, "time")) {
        return await getTimeIndexFallbackInfo(myDatasource, index);
      }
      const timevalues = (
        await ZarrDataManager.getVariableData(myDatasource, "time", [null])
      ).data as Int32Array;

      const timevar = await ZarrDataManager.getVariableInfo(
        myDatasource,
        "time"
      );
      return {
        values: timevalues,
        current: decodeTime(timevalues[index], timevar.attrs),
        attrs: timevar.attrs,
      };
    } catch {
      return {};
    }
  }

  async function getDimensionInfo(
    datasource: TDataSource,
    dimension: TDimensionRange,
    index: number
  ): Promise<TDimInfo> {
    try {
      const dimensionName = dimension?.name;
      if (!dimensionName) {
        return {};
      }

      if (await isUnsupportedCoordinateDataType(datasource, dimensionName)) {
        warnUnsupportedCoordinateOnce(datasource, dimensionName);
        return {};
      }

      const dimArray = await ZarrDataManager.getVariableData(
        datasource,
        dimensionName,
        [null]
      );
      const { dimValues, current } = getCoordinateValues(dimArray.data, index);

      const dimvar = await ZarrDataManager.getVariableInfo(
        datasource,
        dimensionName
      );
      return {
        values: dimValues,
        current,
        attrs: dimvar.attrs,
        units: dimvar.attrs.units as string,
        longName: (dimvar.attrs.long_name ??
          dimvar.attrs.standard_name) as string,
      };
    } catch {
      return {};
    }
  }

  return {
    resetDataVars,
    getDataVar,
    getTimeInfo,
    getDimensionInfo,
  };
}
