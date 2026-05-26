import { watchDebounced } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { watch } from "vue";

import {
  URL_PARAMETERS,
  type TURLParameterValues,
} from "../utils/urlParams.ts";

import { useUrlParameterStore } from "./paramStore.ts";
import { useGlobeControlStore } from "./store.ts";

type TGlobeControlStoreKeys = keyof ReturnType<
  typeof useGlobeControlStore
>["$state"];
type TUrlParameterStoreKeys = keyof ReturnType<
  typeof useUrlParameterStore
>["$state"];

type TGlobeUrlSyncEntry = {
  key: TGlobeControlStoreKeys;
  param: TURLParameterValues;
  transform?: (value: unknown) => string | number;
  skip?: (value: unknown) => boolean;
};

type TUrlParameterSyncEntry = {
  key: TUrlParameterStoreKeys;
  param: TURLParameterValues;
  transform?: (value: unknown) => string | number;
  skip?: (value: unknown) => boolean;
};

const GLOBE_URL_SYNC_MAP: TGlobeUrlSyncEntry[] = [
  {
    key: "varnameSelector",
    param: URL_PARAMETERS.VARNAME,
    skip: (value) => !value || value === "-",
  },
  { key: "colormap", param: URL_PARAMETERS.COLORMAP },
  {
    key: "invertColormap",
    param: URL_PARAMETERS.INVERT_COLORMAP,
    transform: String,
  },
  {
    key: "posterizeLevels",
    param: URL_PARAMETERS.POSTERIZE_LEVELS,
    transform: String,
  },
  {
    key: "hideLowerBound",
    param: URL_PARAMETERS.HIDE_LOWER_BOUND,
    transform: String,
  },
  { key: "landSeaMaskChoice", param: URL_PARAMETERS.MASK_MODE },
  {
    key: "landSeaMaskUseTexture",
    param: URL_PARAMETERS.MASK_USE_TEXTURE,
    transform: String,
  },
  { key: "projectionMode", param: URL_PARAMETERS.PROJECTION },
];

const URL_PARAM_SYNC_MAP: TUrlParameterSyncEntry[] = [
  {
    key: "paramCameraState",
    param: URL_PARAMETERS.CAMERA_STATE,
    skip: (value) => !value,
  },
  {
    key: "paramGridType",
    param: URL_PARAMETERS.GRID_TYPE,
    transform: (value) => (value === undefined ? "" : String(value)),
  },
];

/* eslint-disable-next-line max-lines-per-function */
export function useUrlSync() {
  const store = useGlobeControlStore();
  const { userBoundsHigh, userBoundsLow, dimSlidersDisplay, projectionCenter } =
    storeToRefs(store);
  const urlParameterStore = useUrlParameterStore();

  function changeURLHash(
    entries: Partial<Record<TURLParameterValues, string | number>>
  ) {
    // usage of history.replaceState to avoid triggering hashchange event which is
    // handled in the HashGlobeView component and is used for initial loading of
    // the resource and parameters. Otherwise it would trigger an infinite loop
    const [resource, ...paramArray] = location.hash.substring(1).split("::");
    const paramString = paramArray.join("&");
    const params = new URLSearchParams(paramString);

    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined || value === "") {
        params.delete(key);
        continue;
      }

      params.set(key, value as string);
    }

    history.replaceState(
      null,
      "",
      document.location.pathname +
        "#" +
        resource +
        "::" +
        Object.entries(Object.fromEntries(params))
          .map(([k, v]) => `${k}=${v}`)
          .join("::")
    );
  }

  for (const { key, param, transform, skip } of GLOBE_URL_SYNC_MAP) {
    watch(
      () => store[key],
      (value) => {
        if (skip?.(value)) {
          return;
        }
        changeURLHash({
          [param]: transform ? transform(value) : (value as string | number),
        });
      }
    );
  }

  for (const { key, param, transform, skip } of URL_PARAM_SYNC_MAP) {
    watch(
      () => urlParameterStore[key],
      (value) => {
        if (skip?.(value)) {
          return;
        }
        changeURLHash({
          [param]: transform ? transform(value) : (value as string | number),
        });
      }
    );
  }

  watchDebounced(
    () => [userBoundsLow.value, userBoundsHigh.value],
    () => {
      const bothSet =
        userBoundsLow.value !== undefined && userBoundsHigh.value !== undefined;
      const bothUnset =
        userBoundsLow.value === undefined && userBoundsHigh.value === undefined;
      if (bothSet || bothUnset) {
        changeURLHash({
          [URL_PARAMETERS.USER_BOUNDS_LOW]: userBoundsLow.value as number,
          [URL_PARAMETERS.USER_BOUNDS_HIGH]: userBoundsHigh.value as number,
        });
      }
    },
    { debounce: 200 }
  );

  watch(
    () => dimSlidersDisplay.value,
    () => {
      const dimension = store.varinfo?.dimRanges;
      if (!dimension) {
        return;
      }
      const dimensionValues = {} as Record<string, number | null>;
      for (let i = 0; i < dimension?.length; i++) {
        if (dimension[i] === null) {
          continue;
        }
        dimensionValues[`dimIndices_${dimension[i]?.name}` as string] =
          store.dimSlidersDisplay[i];
      }
      changeURLHash(dimensionValues);
    },
    { deep: true }
  );

  watchDebounced(
    () => [projectionCenter.value?.lat, projectionCenter.value?.lon],
    () => {
      const center = projectionCenter.value;
      if (!center) {
        return;
      }
      changeURLHash({
        [URL_PARAMETERS.PROJECTION_CENTER_LAT]: center.lat,
        [URL_PARAMETERS.PROJECTION_CENTER_LON]: center.lon,
      });
    },
    { debounce: 200 }
  );
}
