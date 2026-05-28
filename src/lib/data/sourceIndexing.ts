import * as zarr from "zarrita";

import {
  ZARR_FORMAT,
  type TDataSource,
  type TSources,
  type TZarrFormat,
} from "../types/GlobeTypes.ts";

import { ZarrDataManager } from "./ZarrDataManager.ts";

import trim from "@/utils/trim.ts";

type TNodeListedStore = zarr.AsyncReadable & {
  listNodes: () => Array<{ path: string; nodeData?: { type?: string } }>;
};

function isNodeListedStore(
  store: zarr.AsyncReadable
): store is TNodeListedStore {
  return (
    typeof (
      store as {
        listNodes?: unknown;
      }
    ).listNodes === "function"
  );
}

async function openDatasetGroup(
  storePath: string,
  format: "v2" | "v3"
): Promise<zarr.Group<zarr.AsyncReadable>> {
  const baseStore = await ZarrDataManager.createNewStore(storePath);
  try {
    const store = await zarr.withConsolidatedMetadata(baseStore, { format });
    return await zarr.open(store, { kind: "group" });
  } catch (consolidatedError) {
    const fallbackStore = await ZarrDataManager.createNewStore(storePath);
    const store = zarr.root(fallbackStore);
    try {
      return await zarr.open(store, { kind: "group" });
    } catch (unconsolidatedError) {
      throw new AggregateError(
        [consolidatedError, unconsolidatedError],
        `Failed to open ${format} Zarr group at ${storePath}`
      );
    }
  }
}

/**
 * Return the effective dimension names for a zarr variable.
 *
 * Zarr v3 arrays store dimension names in the `dimension_names` metadata
 * field (exposed by zarrita as `variable.dimensionNames`).  When the data
 * was originally stored as zarr v2 and converted to an Icechunk repository
 * without migrating the `_ARRAY_DIMENSIONS` attribute to `dimension_names`,
 * zarrita returns `undefined` for `dimensionNames`.  In that case we fall
 * back to the `_ARRAY_DIMENSIONS` zarr attribute which is the zarr v2
 * convention for encoding dimension names.
 */
function getEffectiveDimensionNames(
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>
): string[] | undefined {
  if (Array.isArray(variable.dimensionNames)) {
    return variable.dimensionNames as string[];
  }
  const dimAttr = variable.attrs._ARRAY_DIMENSIONS;
  if (Array.isArray(dimAttr)) {
    return dimAttr as string[];
  }
  return undefined;
}

function isValidVariable(
  varname: string,
  shape: number[],
  dimensions?: string[]
) {
  const EXCLUDED_VAR_PATTERNS = [
    "bnds",
    "bounds",
    "vertices",
    "latitude",
    "longitude",
  ] as const;

  const hasExcludedName = EXCLUDED_VAR_PATTERNS.some((pattern) =>
    varname.includes(pattern)
  );
  // Check both full name and leaf name (e.g. "0/lat" → leaf "lat") so that
  // group-prefixed coordinate arrays are also excluded.
  const leafName = varname.split("/").pop() ?? varname;
  const isLatLon = leafName === "lat" || leafName === "lon";

  if (hasExcludedName || isLatLon) {
    return false;
  }

  if (!Array.isArray(dimensions)) {
    // No dimension metadata available (e.g. zarr v3 array without
    // `dimension_names` and no `_ARRAY_DIMENSIONS` attribute).  Use the
    // array shape as a heuristic: treat multi-dimensional arrays as data
    // variables.  1-D arrays are coordinate/auxiliary arrays (lat, lon,
    // time, …) and are excluded via the name-pattern checks above or by
    // the shape check here.
    return shape.length >= 2;
  }

  const hasTime = dimensions.includes("time");
  const shapeValid = hasTime ? shape.length >= 2 : shape.length >= 1;

  return shapeValid;
}

function searchDimensionsAndCoordinates(
  dimensions: Set<string>,
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const effectiveDims = getEffectiveDimensionNames(variable);
  if (effectiveDims) {
    for (const dim of effectiveDims) {
      dimensions.add(dim);
    }
  }

  if (variable.attrs.coordinates) {
    const coords = variable.attrs.coordinates as string;
    for (const coord of coords.split(" ")) {
      dimensions.add(coord);
    }
  }
}

function isArrayEntry(kind: "array" | "group") {
  return kind === "array";
}

async function collectArrayEntry(
  path: zarr.AbsolutePath,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  dimensions: Set<string>
) {
  const variable = await zarr.open(root.resolve(path), {
    kind: "array",
  });
  searchDimensionsAndCoordinates(dimensions, variable);

  const effectiveDims = getEffectiveDimensionNames(variable);
  // Use the full path (minus leading "/") as the variable name so that nested
  // group paths are preserved (e.g. "0/climate") and the VariableSelector can
  // expose the level/group hierarchy to the user.  dataset="" means the root
  // group is used as the base when fetching data.
  const varname = path.slice(1);
  return {
    [varname]: {
      store: src,
      dataset: "",
      hidden: !isValidVariable(varname, variable.shape, effectiveDims),
      attrs: {
        ...variable.attrs,
        dimensionNames: effectiveDims ?? variable.dimensionNames,
      },
    },
  };
}

async function collectVariables(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string
): Promise<{
  candidates: PromiseSettledResult<Record<string, TDataSource>>[];
  dimensions: Set<string>;
}> {
  const dimensions = new Set<string>();
  const candidates = await Promise.allSettled(
    store
      .contents()
      .filter(
        ({ kind }: { path: zarr.AbsolutePath; kind: "array" | "group" }) =>
          isArrayEntry(kind)
      )
      .map(({ path }: { path: zarr.AbsolutePath; kind: "array" | "group" }) =>
        collectArrayEntry(path, root, src, dimensions)
      )
  );

  return { candidates, dimensions };
}

function getParentDatasetPath(absPath: string): string {
  const normalizedAbsPath = absPath.replace(/^\/+/, "");
  // Root-level arrays (e.g. "/varname") intentionally map to the root dataset.
  if (!normalizedAbsPath.includes("/")) {
    return "";
  }
  return normalizedAbsPath.split("/").slice(0, -1).join("/");
}

function isNodeWithinGroup(nodePath: string, groupAbsPath: string | null) {
  return (
    !groupAbsPath ||
    nodePath === groupAbsPath ||
    nodePath.startsWith(`${groupAbsPath}/`)
  );
}

async function collectNodeListedVariable(
  node: { path: string },
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  groupAbsPath: string | null,
  groupPath: string,
  dimensions: Set<string>
) {
  const variable = await zarr.open(root.resolve(node.path), {
    kind: "array",
  });
  searchDimensionsAndCoordinates(dimensions, variable);

  const effectiveDims = getEffectiveDimensionNames(variable);
  const absPath = node.path; // e.g. "/group1/group2/varname"
  const normalizedAbsPath = absPath.replace(/^\/+/, "");
  const parentDataset = getParentDatasetPath(absPath);
  const varname =
    groupAbsPath && absPath.startsWith(`${groupAbsPath}/`)
      ? absPath.slice(groupAbsPath.length + 1)
      : normalizedAbsPath;
  const datasetPath = groupPath || parentDataset;

  return {
    [varname]: {
      store: src,
      dataset: datasetPath,
      hidden: !isValidVariable(varname, variable.shape, effectiveDims),
      attrs: {
        ...variable.attrs,
        dimensionNames: effectiveDims ?? variable.dimensionNames,
      },
    },
  };
}

async function collectVariablesFromNodeList(
  store: TNodeListedStore,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  groupPath: string = ""
): Promise<{
  candidates: PromiseSettledResult<Record<string, TDataSource>>[];
  dimensions: Set<string>;
}> {
  // If a group path is provided, include only arrays in that group subtree.
  const groupAbsPath = groupPath ? `/${groupPath}` : null;

  const dimensions = new Set<string>();
  const candidates = await Promise.allSettled(
    store
      .listNodes()
      .filter((node) => node.nodeData?.type === "array")
      .filter((node) => isNodeWithinGroup(node.path, groupAbsPath))
      .map((node) =>
        collectNodeListedVariable(
          node,
          root,
          src,
          groupAbsPath,
          groupPath,
          dimensions
        )
      )
  );

  return { candidates, dimensions };
}

function mergeDatasourceCandidates(
  candidates: PromiseSettledResult<Record<string, TDataSource>>[],
  dimensions: Set<string>
): Record<string, TDataSource> {
  return candidates
    .filter((promise) => promise.status === "fulfilled")
    .map((promise) => promise.value)
    .filter((obj) => Object.keys(obj).length > 0)
    .map((obj) => {
      const varname = Object.keys(obj)[0];
      // Also check the leaf name (after the last "/") so that
      // group-prefixed dimension variables like "0/x" or "0/lat" are hidden.
      const leafName = varname.split("/").pop() ?? varname;
      if (dimensions.has(varname) || dimensions.has(leafName)) {
        return { [varname]: { ...obj[varname], hidden: true } };
      }
      return obj;
    })
    .reduce((a, b) => ({ ...a, ...b }), {});
}

async function processZarrVariables(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string
): Promise<Record<string, TDataSource>> {
  const { candidates, dimensions } = await collectVariables(store, root, src);
  return mergeDatasourceCandidates(candidates, dimensions);
}

async function processNodeListedVariables(
  store: TNodeListedStore,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  groupPath: string = ""
): Promise<Record<string, TDataSource>> {
  const { candidates, dimensions } = await collectVariablesFromNodeList(
    store,
    root,
    src,
    groupPath
  );
  return mergeDatasourceCandidates(candidates, dimensions);
}

async function indexFromIcechunkFallback(
  src: string,
  v2Error: unknown,
  v3Error: unknown
): Promise<TSources> {
  // Find the actual Icechunk store root – if `src` already points to the root
  // this is a single attempt; if it embeds a nested-group path the function
  // probes progressively shorter prefixes to discover the real store URL.
  const { storePath: icechunkStorePath, groupPath } =
    await ZarrDataManager.splitIcechunkStoreAndGroup(src);

  const store = await ZarrDataManager.createNewStore(icechunkStorePath).catch(
    () => null
  );
  if (!store || !isNodeListedStore(store)) {
    throw new AggregateError(
      [v2Error, v3Error],
      `Failed to open source at ${src} as Zarr v2 or Zarr v3, and Icechunk fallback was unavailable for ${icechunkStorePath}`
    );
  }
  const root = await zarr.open(zarr.root(store), { kind: "group" });
  const datasources = await processNodeListedVariables(
    store,
    root,
    icechunkStorePath,
    groupPath
  );
  return createIndex(
    root.attrs?.title as string,
    datasources,
    icechunkStorePath,
    ZARR_FORMAT.V3,
    groupPath
  );
}

function createIndex(
  title: string,
  datasources: Record<string, TDataSource>,
  src: string,
  zarrFormat: TZarrFormat,
  groupPath: string = ""
): TSources {
  const defaultDataset = groupPath || inferSharedDatasetPath(datasources);
  return {
    name: title,
    zarr_format: zarrFormat, // eslint-disable-line camelcase
    levels: [
      {
        time: {
          store: src,
          dataset: defaultDataset,
        },
        grid: {
          store: src,
          dataset: defaultDataset,
        },
        datasources,
      },
    ],
  };
}

function inferSharedDatasetPath(
  datasources: Record<string, TDataSource>
): string {
  const datasets = new Set(
    Object.values(datasources)
      .map((source) => source.dataset)
      .filter((dataset) => dataset.length > 0)
  );
  return datasets.size === 1 ? Array.from(datasets)[0] : "";
}

export async function indexFromZarr(src: string): Promise<TSources> {
  try {
    const store = await zarr.withConsolidatedMetadata(
      await ZarrDataManager.createNewStore(src),
      { format: "v2" }
    );
    const root = await zarr.open(store, { kind: "group" });
    const datasources = await processZarrVariables(store, root, src);
    return createIndex(
      root.attrs?.title as string,
      datasources,
      src,
      ZARR_FORMAT.V2
    );
  } catch (v2Error) {
    try {
      const store = await zarr.withConsolidatedMetadata(
        await ZarrDataManager.createNewStore(src),
        { format: "v3" }
      );
      const root = await zarr.open(store, { kind: "group" });
      const datasources = await processZarrVariables(store, root, src);
      return createIndex(
        root.attrs?.title as string,
        datasources,
        src,
        ZARR_FORMAT.V3
      );
    } catch (v3Error) {
      return await indexFromIcechunkFallback(src, v2Error, v3Error);
    }
  }
}

/**
 * JSON-based index may contain variables which belong to different dataset.
 * This function collects variable names by their dataset combination, so
 * that we can fetch metadata for each store only once.
 */
function collectStores(
  datasources: Record<string, TDataSource>
): Record<string, Set<string>> {
  const stores: Record<string, Set<string>> = {};
  for (const varname in datasources) {
    const variable = datasources[varname];
    const store = trim(variable.store, "/") + "/" + trim(variable.dataset, "/");
    if (!stores[store]) {
      stores[store] = new Set();
    }
    stores[store].add(varname);
  }
  return stores;
}

/**
 * Enrich the index with dimension names and attributes from Zarr metadata.
 */
async function enrichMetadata(
  stores: Record<string, Set<string>>,
  datasources: Record<string, TDataSource>,
  format: "v2" | "v3"
) {
  for (const [store, vars] of Object.entries(stores)) {
    const root = await openDatasetGroup(store, format);

    for (const varname of vars) {
      try {
        const variable = await zarr.open(root.resolve(`/${varname}`), {
          kind: "array",
        });
        const arrayDimensions = variable.dimensionNames ?? [];
        datasources[varname].attrs = {
          ...datasources[varname].attrs,
          ...variable.attrs,
          dimensionNames: arrayDimensions,
        } as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
  }
}

export async function indexFromIndex(src: string): Promise<TSources> {
  const res = await fetch(src);
  if (!res.ok) {
    throw new Error(`Failed to fetch index from ${src}: ${res.statusText}`);
  } else if (res.status >= 400) {
    throw new Error(`Index not found at ${src}`);
  }
  const sources = (await res.json()) as TSources;
  const datasources = sources.levels[0].datasources;
  const stores = collectStores(datasources);
  try {
    await enrichMetadata(stores, datasources, "v3");
    sources.zarr_format = ZARR_FORMAT.V3; // eslint-disable-line camelcase
  } catch {
    await enrichMetadata(stores, datasources, "v2");
    sources.zarr_format = ZARR_FORMAT.V2; // eslint-disable-line camelcase
  }
  return sources;
}
