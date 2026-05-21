<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";
import * as zarr from "zarrita";

import VariableTableSection from "./VariableTableSection.vue";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type { TDataSource, TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

type TVariableMetadata = {
  attrs: zarr.Attributes | null;
  dimensions: string[];
  dtype: string | null;
  loading: boolean;
  error: string | null;
};

const props = defineProps<{
  datasources?: TSources;
  varname?: string | null;
}>();

const store = useGlobeControlStore();
const { varnameSelector } = storeToRefs(store);
const { logError } = useLog();

const metadataByName = ref<Record<string, TVariableMetadata>>({});
const selectedAttributesVariableName = ref<string | null>(null);
let metadataLoadId = 0;

function normalizeDimensionNames(
  dimensionNames: unknown,
  shape?: readonly number[]
) {
  if (Array.isArray(dimensionNames)) {
    return dimensionNames.map(String);
  }
  if (shape) {
    return shape.map((_, idx) => `dim_${idx}`);
  }
  return [];
}

function getDefaultAttributesVariableName(datasources?: TSources) {
  const variableName = varnameSelector.value;
  if (!datasources || !variableName || variableName === "-") {
    return null;
  }

  const source = datasources.levels[0].datasources[variableName];
  if (!source || source.hidden) {
    return null;
  }
  return variableName;
}

/**
 * Build variable metadata from the already-indexed datasource without any
 * network fetch.  Returns null when the indexed data is incomplete (e.g. JSON
 * indexes that do not pre-populate dtype/shape), in which case a fallback
 * fetch will be performed.
 */
function buildMetadataFromSource(
  name: string,
  source: TDataSource
): TVariableMetadata | null {
  const dimensionNames = source.attrs?.dimensionNames;
  const dims = normalizeDimensionNames(dimensionNames, source.shape);
  const dtype = source.dtype ?? null;

  // If we have neither dtype nor dimension info, we need a fetch.
  if (!dtype && !Array.isArray(dimensionNames)) {
    return null;
  }

  // Strip internal dimension tracking keys that are not user-visible attributes
  const attrsWithoutDims = Object.fromEntries(
    Object.entries(source.attrs ?? {}).filter(
      ([k]) => k !== "_ARRAY_DIMENSIONS" && k !== "dimensionNames"
    )
  ) as zarr.Attributes;

  return {
    attrs: attrsWithoutDims,
    dimensions: dims,
    dtype,
    loading: false,
    error:
      !dtype && !Array.isArray(dimensionNames)
        ? `Incomplete indexed metadata for variable ${name}`
        : null,
  };
}

function updateMetadata(name: string, metadata: TVariableMetadata) {
  metadataByName.value = {
    ...metadataByName.value,
    [name]: metadata,
  };
}

async function loadVariableMetadata(
  loadId: number,
  name: string,
  source: TDataSource
) {
  try {
    const variable = await ZarrDataManager.getVariableInfo(source, name);
    if (loadId !== metadataLoadId) {
      return;
    }
    updateMetadata(name, {
      attrs: variable.attrs,
      dimensions: normalizeDimensionNames(
        variable.dimensionNames,
        variable.shape
      ),
      dtype: String(variable.dtype),
      loading: false,
      error: null,
    });
  } catch (err) {
    logError(err);
    if (loadId !== metadataLoadId) {
      return;
    }
    updateMetadata(name, {
      ...metadataByName.value[name],
      loading: false,
      error: `Could not load metadata for ${name}`,
    });
  }
}

async function loadAllVariableMetadata(datasources?: TSources) {
  const loadId = ++metadataLoadId;
  selectedAttributesVariableName.value =
    getDefaultAttributesVariableName(datasources);
  if (!datasources) {
    metadataByName.value = {};
    return;
  }

  const entries = Object.entries(datasources.levels[0].datasources);

  // First pass: populate from indexed metadata without any network requests
  metadataByName.value = Object.fromEntries(
    entries.map(([name, source]) => {
      const cached = buildMetadataFromSource(name, source);
      return [
        name,
        cached ?? {
          attrs: source.attrs ?? null,
          dimensions: normalizeDimensionNames(
            source.attrs?.dimensionNames,
            source.shape
          ),
          dtype: null,
          loading: true,
          error: null,
        },
      ];
    })
  );

  // Second pass: fetch only variables where indexed metadata was incomplete
  const needsFetch = entries.filter(
    ([name, source]) => buildMetadataFromSource(name, source) === null
  );
  await Promise.all(
    needsFetch.map(([name, source]) =>
      loadVariableMetadata(loadId, name, source)
    )
  );
}

const datasourceEntries = computed(() => {
  if (!props.datasources) {
    return [];
  }
  return Object.entries(props.datasources.levels[0].datasources);
});

const allVariables = computed(() =>
  datasourceEntries.value.map(([name, source]) => {
    const metadata = metadataByName.value[name] ?? {
      attrs: source.attrs ?? null,
      dimensions: normalizeDimensionNames(
        source.attrs?.dimensionNames,
        source.shape
      ),
      dtype: source.dtype ?? null,
      loading: !source.dtype && !Array.isArray(source.attrs?.dimensionNames),
      error: null,
    };
    return {
      name,
      hidden: source.hidden ?? false,
      ...metadata,
    };
  })
);

const coordinateVariables = computed(() =>
  allVariables.value.filter((variable) => variable.hidden)
);

const dataVariables = computed(() =>
  allVariables.value.filter((variable) => !variable.hidden)
);

const isTimeFromAnotherFile = computed(() => {
  if (!props.datasources) {
    return true;
  }
  const time = props.datasources.levels[0].time;
  const currentVariable =
    props.datasources.levels[0].datasources[props.varname ?? ""] ?? null;
  if (!time || !currentVariable) {
    // We only show the warning if there is a time variable and a selected
    // variable, otherwise it can be confusing
    return true;
  }
  return (
    time?.dataset + "/" + time?.store !==
    currentVariable?.dataset + "/" + currentVariable?.store
  );
});

const isGridFromAnotherFile = computed(() => {
  if (!props.datasources) {
    return true;
  }
  const grid = props.datasources.levels[0].grid;
  const currentVariable =
    props.datasources.levels[0].datasources[props.varname ?? ""] ?? null;
  if (!grid || !currentVariable) {
    // We only show the warning if there is a grid and a selected
    // variable, otherwise it can be confusing
    return true;
  }
  return (
    grid?.dataset + "/" + grid?.store !==
    currentVariable?.dataset + "/" + currentVariable?.store
  );
});

function toggleVariableAttributes(varName: string) {
  selectedAttributesVariableName.value =
    selectedAttributesVariableName.value === varName ? null : varName;
}

function selectVariable(varName: string) {
  selectedAttributesVariableName.value = varName;
  varnameSelector.value = varName;
}

watch(
  () => props.datasources,
  (datasources) => {
    void loadAllVariableMetadata(datasources);
  },
  { immediate: true }
);

watch(
  () => varnameSelector.value,
  () => {
    const defaultVariable = getDefaultAttributesVariableName(props.datasources);
    if (defaultVariable) {
      selectedAttributesVariableName.value = defaultVariable;
    }
  }
);
</script>

<template>
  <div>
    <section v-if="allVariables.length > 0" class="info-section">
      <h4 class="title is-6">Variables</h4>
      <p v-if="isTimeFromAnotherFile" class="is-size-7 has-text-danger">
        Time variable is from a different file and may not be correctly
        recognized.
      </p>
      <p v-if="isGridFromAnotherFile" class="is-size-7 has-text-danger">
        Grid related dimensions are from a different file and may not be
        correctly recognized.
      </p>
      <VariableTableSection
        title="Coordinates"
        :rows="coordinateVariables"
        empty-label="No coordinates found"
        :selected-attributes-variable="selectedAttributesVariableName"
        @toggle-attributes="toggleVariableAttributes"
      />
      <VariableTableSection
        title="Data Variables"
        :rows="dataVariables"
        empty-label="No data variables found"
        :selected-attributes-variable="selectedAttributesVariableName"
        :selected-variable="varnameSelector"
        show-visualize
        @toggle-attributes="toggleVariableAttributes"
        @visualize="selectVariable"
      />
    </section>
  </div>
</template>
