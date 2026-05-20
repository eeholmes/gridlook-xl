import { IcechunkStore } from "icechunk-js";
import QuickLRU from "quick-lru";
import * as zarr from "zarrita";

import type { TDataSource, TSources } from "@/lib/types/GlobeTypes.ts";

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
    datasource: TDatasetSource
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
    const dataset = await zarr.open(target, { kind: "group" });
    return dataset;
  }

  private static async getVariable(
    store: zarr.Group<zarr.AsyncReadable>,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const fetchPromise = (async () => {
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
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const storePath = this.normalizeStorePath(datasource.store);
    const datasetPath = this.normalizeDatasetPath(datasource.dataset);
    const variablePath = this.normalizeVariablePath(variable);
    const group = await this.getDataset(datasource);
    // For Icechunk stores getDataset returns the root group, so compose the
    // full path from the dataset (group) path and the variable name.
    let varPath = variablePath;
    if (storePath.startsWith(this.ICECHUNK_PREFIX) && datasetPath) {
      const datasetPrefix = `${datasetPath}/`;
      varPath = variablePath.startsWith(datasetPrefix)
        ? variablePath
        : `${datasetPrefix}${variablePath}`;
    }
    const array = await this.getVariable(group, varPath);
    return array;
  }

  static async getVariableInfoByDatasetSources(
    datasource: TSources,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const array = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasource!, variable),
      variable
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
    const variableSource = this.getDatasetSource(datasource, variable);
    return await this.getVariableInfo(variableSource, crsVar);
  }

  static async findCRSVar(datasources: TSources, varname: string) {
    const source = this.getDatasetSource(datasources, varname);
    const datavar = await ZarrDataManager.getVariableInfo(source, varname);
    if (datavar.attrs?.grid_mapping) {
      return String(datavar.attrs.grid_mapping).split(":")[0];
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

  static async getDimensionNames(datasources: TSources, varname: string) {
    const source = this.getDatasetSource(datasources, varname) as TDataSource;
    if (source.attrs && source.attrs.dimensionNames) {
      return source.attrs.dimensionNames as string[];
    }

    const datavar = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasources, varname),
      varname
    );
    return datavar.dimensionNames ?? [];
  }

  static invalidateCache() {
    this.pendingStore = null;
    this.fetchStorePath = null;
  }
}
