<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import { VALUE_TRANSFORMS, type TModelInfo } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const model = defineModel<string>({ required: true });

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const store = useGlobeControlStore();
const { loading, transformMode } = storeToRefs(store);

const allVisibleVariables = computed(() => {
  const visibleVars = Object.keys(props.modelInfo.vars).filter((varname) => {
    const varinfo = props.modelInfo.vars[varname];
    return !varinfo.hidden;
  });
  return visibleVars;
});

/**
 * Collect all unique group paths (everything before the last "/") across all
 * visible variables and return them sorted.  Variables with no "/" prefix are
 * root-level and contribute no group path.
 */
const allGroupPaths = computed(() => {
  const paths = new Set<string>();
  for (const varname of allVisibleVariables.value) {
    const slashIdx = varname.lastIndexOf("/");
    if (slashIdx > 0) {
      paths.add(varname.slice(0, slashIdx));
    }
  }
  return Array.from(paths).sort();
});

/** Whether the dataset has any grouped variables at all. */
const hasGroups = computed(() => allGroupPaths.value.length > 0);

const selectedGroup = ref<string | null>(null);

// Keep selectedGroup valid when the dataset changes.
watch(
  allGroupPaths,
  (paths) => {
    if (paths.length === 0) {
      selectedGroup.value = null;
    } else if (!paths.includes(selectedGroup.value ?? "")) {
      selectedGroup.value = paths[0];
    }
  },
  { immediate: true }
);

const variableOptions = computed(() => {
  if (!hasGroups.value) {
    return allVisibleVariables.value;
  }
  const prefix = selectedGroup.value;
  return allVisibleVariables.value.filter((varname) => {
    const slashIdx = varname.lastIndexOf("/");
    if (slashIdx <= 0) {
      // Root-level variable — always included regardless of group selection.
      return true;
    }
    return varname.slice(0, slashIdx) === prefix;
  });
});

watch(
  () => variableOptions.value,
  (options) => {
    if (options.length === 0) {
      model.value = allVisibleVariables.value[0] ?? "-";
    } else if (!options.includes(model.value)) {
      model.value = options[0];
    }
  },
  { immediate: true }
);

const currentVar = computed(() => props.modelInfo.vars[model.value]);

const currentVarAttrs = computed(() => currentVar.value?.attrs);

const currentVarUnits = computed(() => {
  return currentVarAttrs.value?.units ?? "-";
});

const showCurrentVarUnits = computed(() => {
  return (
    transformMode.value === VALUE_TRANSFORMS.LINEAR &&
    currentVarUnits.value !== "-"
  );
});

const currentVarLabel = computed(() => {
  return (
    currentVarAttrs.value?.long_name ??
    currentVarAttrs.value?.standard_name ??
    "-"
  );
});

function getOptionLabel(varname: string): string {
  const v = props.modelInfo.vars[varname];
  const label = v?.attrs?.long_name ?? v?.attrs?.standard_name;
  // Show only the leaf name in the variable dropdown since the group is
  // already shown separately in the group selector above.
  const displayName = varname.split("/").pop() ?? varname;
  return label ? `${displayName} - ${label}` : displayName;
}
</script>

<template>
  <div class="column">
    <div class="control">
      <template v-if="hasGroups">
        <label class="is-size-7 has-text-grey" for="group-selector">
          Group
        </label>
        <div class="select is-fullwidth mb-2">
          <select
            id="group-selector"
            v-model="selectedGroup"
            class="form-control"
            aria-label="Group"
          >
            <option v-for="group in allGroupPaths" :key="group" :value="group">
              {{ group }}
            </option>
          </select>
        </div>
      </template>
      <div class="select is-fullwidth mb-2" :class="{ 'is-loading': loading }">
        <select v-model="model" class="form-control">
          <option
            v-for="varname in variableOptions"
            :key="varname"
            :value="varname"
          >
            {{ getOptionLabel(varname) }}
          </option>
        </select>
      </div>
      <div :key="model" class="has-text-right">
        <span v-word-break>
          {{ currentVarLabel }}
        </span>
        <template v-if="showCurrentVarUnits"> / {{ currentVarUnits }}</template>
      </div>
    </div>
  </div>
</template>
