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

  if (!Array.isArray(dimensions)) {
    return false;
  }

  const hasTime = dimensions.includes("time");
  const shapeValid = hasTime ? shape.length >= 2 : shape.length >= 1;

  const hasExcludedName = EXCLUDED_VAR_PATTERNS.some((pattern) =>
    varname.includes(pattern)
  );
  const isLatLon = varname === "lat" || varname === "lon";

  return shapeValid && !hasExcludedName && !isLatLon;
}

function searchDimensionsAndCoordinates(
  dimensions: Set<string>,
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  if (Array.isArray(variable.dimensionNames)) {
    for (const dim of variable.dimensionNames) {
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

function isUnsupportedDataTypeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Unknown or unsupported dataType");
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
      .map(
        async ({
          path,
          kind,
        }: {
          path: zarr.AbsolutePath;
          kind: "array" | "group";
        }) => {
          if (kind !== "array") {
            return {};
          }
          const variable = await zarr.open(root.resolve(path), {
            kind: "array",
          });
          searchDimensionsAndCoordinates(dimensions, variable);

          const varname = path.slice(1);
          return {
            [varname]: {
              store: src,
              dataset: "",
              hidden: !isValidVariable(
                varname,
                variable.shape,
                variable.dimensionNames as string[]
              ),
              attrs: {
                ...variable.attrs,
                dimensionNames: variable.dimensionNames,
              },
            },
          };
        }
      )
  );

  return { candidates, dimensions };
}

async function collectVariablesFromNodeList(
  store: TNodeListedStore,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string
): Promise<{
  candidates: PromiseSettledResult<Record<string, TDataSource>>[];
  dimensions: Set<string>;
}> {
  const dimensions = new Set<string>();
  const candidates = await Promise.allSettled(
    store
      .listNodes()
      .filter((node) => node.nodeData?.type === "array")
      .map(async (node) => {
        const variable = await zarr.open(root.resolve(node.path), {
          kind: "array",
        });
        searchDimensionsAndCoordinates(dimensions, variable);

        const varname = node.path.replace(/^\//, "");
        return {
          [varname]: {
            store: src,
            dataset: "",
            hidden: !isValidVariable(
              varname,
              variable.shape,
              variable.dimensionNames as string[]
            ),
            attrs: {
              ...variable.attrs,
              dimensionNames: variable.dimensionNames,
            },
          },
        };
      })
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
      if (dimensions.has(varname)) {
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
  src: string
): Promise<Record<string, TDataSource>> {
  const { candidates, dimensions } = await collectVariablesFromNodeList(
    store,
    root,
    src
  );
  return mergeDatasourceCandidates(candidates, dimensions);
}

async function indexFromIcechunkFallback(
  src: string,
  v2Error: unknown,
  v3Error: unknown
): Promise<TSources> {
  const icechunkStorePath = ZarrDataManager.toIcechunkStorePath(src);
  const store = await ZarrDataManager.createNewStore(icechunkStorePath);
  if (!isNodeListedStore(store)) {
    throw new AggregateError(
      [v2Error, v3Error],
      `Failed to open source at ${src} as Zarr v2 or Zarr v3, and Icechunk fallback was unavailable for ${icechunkStorePath}`
    );
  }
  const root = await zarr.open(zarr.root(store), { kind: "group" });
  const datasources = await processNodeListedVariables(
    store,
    root,
    icechunkStorePath
  );
  return createIndex(
    root.attrs?.title as string,
    datasources,
    icechunkStorePath,
    ZARR_FORMAT.V3
  );
}

function createIndex(
  title: string,
  datasources: Record<string, TDataSource>,
  src: string,
  zarrFormat: TZarrFormat
): TSources {
  return {
    name: title,
    zarr_format: zarrFormat, // eslint-disable-line camelcase
    levels: [
      {
        time: {
          store: src,
          dataset: "",
        },
        grid: {
          store: src,
          dataset: "",
        },
        datasources,
      },
    ],
  };
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
      } catch (error) {
        if (isUnsupportedDataTypeError(error)) {
          delete datasources[varname];
        }
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
