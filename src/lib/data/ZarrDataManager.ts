import { IcechunkStore } from "icechunk-js";
import QuickLRU from "quick-lru";
import * as zarr from "zarrita";

import "./registerZarrCodecs.ts";

import type {
  TDataSource,
  TSources,
  TZarrFormat,
} from "@/lib/types/GlobeTypes.ts";

export type TZarrDatasetMetadata = {
  attrs: zarr.Attributes;
  store: string;
  dataset: string;
};

export type TZarrVariableMetadata = {
  attrs: zarr.Attributes;
  shape: readonly number[];
  chunks: readonly (number | null)[];
  dtype: zarr.Array<zarr.DataType, zarr.FetchStore>["dtype"];
  store: string;
  dataset: string;
  variable: string;
};

type TDatasetSource = Pick<TDataSource, "dataset" | "store">;

export type TResolvedVariableReference = {
  datasource: TDatasetSource;
  variable: string;
};

export class ZarrDataManager {
  private static readonly ICECHUNK_PREFIX = "icechunk+";
  private static pendingStore: Promise<
    zarr.Location<zarr.AsyncReadable>
  > | null = null;
  private static fetchStorePath: string | null = null;

  private static normalizeStorePath(store: string) {
    return store.replace(/\/+$/, "");
  }

  private static parseStorePath(storePath: string): {
    backend: "fetch" | "icechunk";
    url: string;
  } {
    if (storePath.startsWith(this.ICECHUNK_PREFIX)) {
      return {
        backend: "icechunk",
        url: storePath.slice(this.ICECHUNK_PREFIX.length),
      };
    }
    return { backend: "fetch", url: storePath };
  }

  static toIcechunkStorePath(storeUrl: string) {
    return storeUrl.startsWith(this.ICECHUNK_PREFIX)
      ? storeUrl
      : `${this.ICECHUNK_PREFIX}${storeUrl}`;
  }

  /**
   * Given a URL that may point to a nested group inside an Icechunk repository,
   * probes progressively shorter URL prefixes to find the actual Icechunk store
   * root. Returns the store path (with the "icechunk+" prefix) and the group
   * path within the store (empty string when the URL already points to the root).
   *
   * Example: "icechunk+https://host/store/group1/group2"
   *   → { storePath: "icechunk+https://host/store", groupPath: "group1/group2" }
   *
   * Note: in the worst case this makes one HTTP request per path segment before
   * it finds the store root, so it is intentionally used only as a fallback.
   */
  static async splitIcechunkStoreAndGroup(
    src: string
  ): Promise<{ storePath: string; groupPath: string }> {
    const rawUrl = src.startsWith(this.ICECHUNK_PREFIX)
      ? src.slice(this.ICECHUNK_PREFIX.length)
      : src;
    const normalizedUrl = rawUrl.replace(/\/+$/, "");
    const urlParts = normalizedUrl.split("/");

    // For "https://host/a/b" the parts are ["https:", "", "host", "a", "b"].
    // Never strip below the scheme + authority (3 segments for https://).
    let minSegments = urlParts.length;
    if (
      urlParts.length > 2 &&
      urlParts[0].endsWith(":") &&
      urlParts[1] === ""
    ) {
      minSegments = 3;
    }

    for (let i = urlParts.length; i >= minSegments; i--) {
      const storeUrl = urlParts.slice(0, i).join("/");
      const groupPath = urlParts.slice(i).join("/");
      const storePath = `${this.ICECHUNK_PREFIX}${storeUrl}`;
      try {
        await this.createNewStore(storePath);
        return { storePath, groupPath };
      } catch {
        // Not a valid Icechunk store at this URL; try a shorter path.
      }
    }

    // Fallback: nothing worked – return the full URL with an empty group path
    // so the caller can surface a meaningful error.
    return {
      storePath: `${this.ICECHUNK_PREFIX}${normalizedUrl}`,
      groupPath: "",
    };
  }

  private static normalizeDatasetPath(dataset: string) {
    return dataset.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private static normalizeVariablePath(variable: string) {
    return variable.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  public static async createNewStore(storePath: string) {
    const parsed = this.parseStorePath(storePath);
    if (parsed.backend === "icechunk") {
      try {
        return await IcechunkStore.open(parsed.url, {
          withRangeCoalescing: zarr.withRangeCoalescing,
        });
      } catch (error) {
        throw new Error(
          `Failed to open icechunk store from ${storePath} (resolved URL: ${parsed.url})`,
          { cause: error }
        );
      }
    }

    const cache = new QuickLRU<string, Uint8Array | undefined>({
      maxSize: 512,
    });
    const fetchStore = zarr.extendStore(
      new zarr.FetchStore(parsed.url, { useSuffixRequest: true }),
      (s) => zarr.withRangeCoalescing(s, { coalesceSize: 32768 }),
      (s) => zarr.withByteCaching(s, { cache: cache })
    );
    return fetchStore;
  }

  private static async getDataset(
    datasource: TDatasetSource,
    format?: TZarrFormat
  ): Promise<zarr.Group<zarr.AsyncReadable>> {
    const storePath = this.normalizeStorePath(datasource.store);
    if (!this.pendingStore || this.fetchStorePath !== storePath) {
      this.fetchStorePath = storePath;
      this.pendingStore = this.createNewStore(storePath)
        .then((s) => zarr.root(s))
        .catch((e) => {
          // Clear the cache on failure so callers can retry.
          if (this.fetchStorePath === storePath) {
            this.pendingStore = null;
          }
          throw e;
        });
    }
    // Capture locally so a concurrent path switch cannot swap the store under us.
    const root = await this.pendingStore;

    // For Icechunk stores, zarr.open on a nested group path can hang because
    // the Icechunk library may not resolve intermediate group metadata the same
    // way it resolves array metadata. Return the root group unconditionally and
    // let getVariableInfo compose the full variable path (datasetPath + varname).
    if (storePath.startsWith(this.ICECHUNK_PREFIX)) {
      return await zarr.open(root, { kind: "group" });
    }

    const datasetPath = this.normalizeDatasetPath(datasource.dataset);
    const target = datasetPath ? root.resolve(datasetPath) : root;
    let dataset: zarr.Group<zarr.AsyncReadable>;
    if (format === 2) {
      dataset = await zarr.open.v2(target, { kind: "group" });
    } else if (format === 3) {
      dataset = await zarr.open.v3(target, { kind: "group" });
    } else {
      dataset = await zarr.open(target, { kind: "group" });
    }
    return dataset;
  }

  private static async getVariable(
    store: zarr.Group<zarr.AsyncReadable>,
    variable: string,
    format?: TZarrFormat
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const fetchPromise = (async () => {
      if (format === 2) {
        return await zarr.open.v2(store.resolve(variable), { kind: "array" });
      } else if (format === 3) {
        return await zarr.open.v3(store.resolve(variable), { kind: "array" });
      }
      return await zarr.open(store.resolve(variable), {
        kind: "array",
      });
    })();
    const array = await fetchPromise;
    return array;
  }

  static async getDatasetGroup(datasource: TDatasetSource) {
    return await this.getDataset(datasource);
  }

  static async getVariableInfo(
    datasource: TDatasetSource,
    variable: string,
    format?: TZarrFormat
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const storePath = this.normalizeStorePath(datasource.store);
    const datasetPath = this.normalizeDatasetPath(datasource.dataset);
    const variablePath = this.normalizeVariablePath(variable);
    const group = await this.getDataset(datasource, format);
    if (!storePath.startsWith(this.ICECHUNK_PREFIX) || !datasetPath) {
      return await this.getVariable(group, variablePath, format);
    }

    // For Icechunk stores getDataset returns the root group, so compose the
    // full path from the dataset path and variable name. Root indexing may
    // provide either "blh" or "spatial/blh", so try both forms.
    const datasetPrefix = `${datasetPath}/`;
    const prefixedPath = variablePath.startsWith(datasetPrefix)
      ? variablePath
      : `${datasetPrefix}${variablePath}`;
    const unprefixedPath = variablePath.startsWith(datasetPrefix)
      ? variablePath.slice(datasetPrefix.length)
      : variablePath;

    const triedPaths = new Set<string>();
    let lastResolutionError: unknown = null;
    for (const candidatePath of [prefixedPath, unprefixedPath, variablePath]) {
      if (triedPaths.has(candidatePath) || candidatePath.length === 0) {
        continue;
      }
      triedPaths.add(candidatePath);
      try {
        return await this.getVariable(group, candidatePath, format);
      } catch (error) {
        lastResolutionError = error;
        // Try the next candidate path.
      }
    }

    throw new Error(
      `Failed to resolve variable "${variable}" in dataset "${datasetPath}" for store "${storePath}"`,
      {
        cause: lastResolutionError || undefined,
      }
    );
  }

  static async getVariableInfoByDatasetSources(
    datasource: TSources,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const array = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasource!, variable),
      variable,
      datasource.zarr_format
    );
    return array;
  }

  static async getVariableData(
    datasource: TDatasetSource,
    variable: string,
    selection?: (number | null | zarr.Slice)[]
  ) {
    const array = await this.getVariableInfo(datasource, variable);
    if (selection && selection.length > 0) {
      return await zarr.get(array, selection);
    }
    return await zarr.get(array);
  }

  static getVariableDataFromArray(
    array: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
    selection?: (number | null | zarr.Slice)[]
  ) {
    if (selection && selection.length > 0) {
      return zarr.get(array, selection);
    }
    return zarr.get(array);
  }

  static async getCRSInfo(
    datasource: TSources,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const crsVar = await this.findCRSVar(datasource, variable);
    const resolved = this.resolveVariableReference(
      datasource,
      variable,
      crsVar
    );
    return await this.getVariableInfo(
      resolved.datasource,
      resolved.variable,
      datasource.zarr_format
    );
  }

  static async findCRSVar(datasources: TSources, varname: string) {
    const source = this.getDatasetSource(datasources, varname);
    const datavar = await ZarrDataManager.getVariableInfo(
      source,
      varname,
      datasources.zarr_format
    );
    if (datavar.attrs?.grid_mapping) {
      return String(datavar.attrs.grid_mapping).split(":")[0];
    }

    // Also search auxiliary coordinates (e.g. "spatial_ref" written by
    // rioxarray / xarray-spatial) for a variable carrying CRS metadata.
    if (datavar.attrs?.coordinates) {
      const coords = String(datavar.attrs.coordinates).split(" ");
      const results = await Promise.all(
        coords.map(async (coord) => {
          try {
            const resolved = this.resolveVariableReference(
              datasources,
              varname,
              coord
            );
            const coordVar = await this.getVariableInfo(
              resolved.datasource,
              resolved.variable,
              datasources.zarr_format
            );
            if (coordVar.attrs?.crs_wkt || coordVar.attrs?.grid_mapping_name) {
              return coord;
            }
          } catch {
            // Not a CRS variable or not found — continue scanning.
          }
          return null;
        })
      );
      const found = results.find((r) => r !== null);
      if (found !== undefined) {
        return found;
      }
    }

    const group = await ZarrDataManager.getDatasetGroup(source);
    if (group.attrs?.grid_mapping) {
      return String(group.attrs.grid_mapping).split(":")[0];
    }
    return "crs";
  }

  static getDatasetSource(
    datasources: TSources,
    varname: string
  ): TDatasetSource {
    return datasources.levels[0].datasources[varname];
  }

  /**
   * Walk up the group hierarchy of `currentVarname` looking for `target`
   * in the sibling or ancestor group.  E.g. for currentVarname "0/climate"
   * and target "x" this tries "0/x"; for "0/20m/temp" it tries "0/20m/x"
   * then "0/x".  Root-level lookup (bare "x") is already handled by the
   * directMatch check in resolveVariableReference before this is called.
   * Returns null when no match is found.
   */
  private static resolveInParentGroups(
    levelDatasources: Record<string, TDatasetSource>,
    currentVarname: string,
    normalizedTarget: string
  ): TResolvedVariableReference | null {
    const currentParts = this.normalizeVariablePath(currentVarname).split("/");
    // Walk from the immediate parent group up to the top-most named group.
    // i = currentParts.length-1 → nearest ancestor, i = 1 → top-level group.
    // Root level (i = 0) is covered by the directMatch above.
    for (let i = currentParts.length - 1; i >= 1; i--) {
      const groupPrefix = currentParts.slice(0, i).join("/");
      const candidate = `${groupPrefix}/${normalizedTarget}`;
      const match = levelDatasources[candidate];
      if (match) {
        return { datasource: match, variable: candidate };
      }
    }
    return null;
  }

  static resolveVariableReference(
    datasources: TSources,
    currentVarname: string,
    targetVarname: string
  ): TResolvedVariableReference {
    const levelDatasources = datasources.levels[0].datasources;
    const normalizedTarget = this.normalizeVariablePath(targetVarname);
    const directMatch = levelDatasources[normalizedTarget];
    if (directMatch) {
      return { datasource: directMatch, variable: normalizedTarget };
    }

    const groupMatch = this.resolveInParentGroups(
      levelDatasources,
      currentVarname,
      normalizedTarget
    );
    if (groupMatch) {
      return groupMatch;
    }

    const currentSource = this.getDatasetSource(datasources, currentVarname);
    const currentDataset = this.normalizeDatasetPath(currentSource.dataset);
    const datasetQualifiedTarget = currentDataset
      ? `${currentDataset}/${normalizedTarget}`
      : normalizedTarget;
    const datasetQualifiedMatch = levelDatasources[datasetQualifiedTarget];
    if (datasetQualifiedMatch) {
      return {
        datasource: datasetQualifiedMatch,
        variable: datasetQualifiedTarget,
      };
    }

    const targetLeafName =
      normalizedTarget.split("/").pop() ?? normalizedTarget;
    const sameDatasetMatch = Object.entries(levelDatasources).find(
      ([varname, source]) =>
        (this.normalizeVariablePath(varname).split("/").pop() ?? varname) ===
          targetLeafName &&
        this.normalizeDatasetPath(source.dataset) === currentDataset
    );
    if (sameDatasetMatch) {
      const [matchedVarname, matchedSource] = sameDatasetMatch;
      return { datasource: matchedSource, variable: matchedVarname };
    }

    return { datasource: currentSource, variable: normalizedTarget };
  }

  static async getDimensionNames(datasources: TSources, varname: string) {
    const source = this.getDatasetSource(datasources, varname) as TDataSource;
    if (source.attrs && source.attrs.dimensionNames) {
      return source.attrs.dimensionNames as string[];
    }

    const datavar = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasources, varname),
      varname,
      datasources.zarr_format
    );
    return datavar.dimensionNames ?? [];
  }

  static invalidateCache() {
    this.pendingStore = null;
    this.fetchStorePath = null;
  }
}
