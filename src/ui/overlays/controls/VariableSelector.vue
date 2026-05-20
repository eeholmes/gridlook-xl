<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import type { TModelInfo } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store.ts";

const model = defineModel<string>({ required: true });

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const store = useGlobeControlStore();
const { loading } = storeToRefs(store);

const allVisibleVariables = computed(() => {
  const visibleVars = Object.keys(props.modelInfo.vars).filter((varname) => {
    const varinfo = props.modelInfo.vars[varname];
    return !varinfo.hidden;
  });
  return visibleVars;
});

function getGroupSegments(varname: string) {
  const parts = varname.split("/");
  return parts.slice(0, -1);
}

const maxGroupDepth = computed(() =>
  allVisibleVariables.value.reduce((depth, varname) => {
    return Math.max(depth, getGroupSegments(varname).length);
  }, 0)
);

const selectedGroupSegments = ref<Array<string | null>>(
  Array.from({ length: maxGroupDepth.value }, () => null)
);

function getGroupOptionsForLevel(
  level: number,
  selections: Array<string | null>
) {
  const options = new Set<string>();
  for (const varname of allVisibleVariables.value) {
    const segments = getGroupSegments(varname);
    if (segments.length <= level) {
      continue;
    }
    const parentMatches = selections
      .slice(0, level)
      .every((selected, idx) => !selected || segments[idx] === selected);
    if (parentMatches) {
      options.add(segments[level]);
    }
  }
  return Array.from(options);
}

watch(
  () => maxGroupDepth.value,
  (depth) => {
    selectedGroupSegments.value = selectedGroupSegments.value
      .slice(0, depth)
      .concat(
        Array.from(
          { length: Math.max(0, depth - selectedGroupSegments.value.length) },
          () => null
        )
      );
  },
  { immediate: true }
);

const groupOptionsByLevel = computed(() => {
  const optionsByLevel: string[][] = [];
  for (let level = 0; level < maxGroupDepth.value; level++) {
    optionsByLevel[level] = getGroupOptionsForLevel(
      level,
      selectedGroupSegments.value
    );
  }
  return optionsByLevel;
});

watch(
  () => [
    allVisibleVariables.value,
    maxGroupDepth.value,
    selectedGroupSegments.value,
  ],
  () => {
    const next = selectedGroupSegments.value.slice(0, maxGroupDepth.value);
    let changed = next.length !== selectedGroupSegments.value.length;
    for (let i = 0; i < maxGroupDepth.value; i++) {
      const options = getGroupOptionsForLevel(i, next);
      const selected = next[i];
      if (typeof selected !== "string" || !options.includes(selected)) {
        next[i] = options[0] ?? null;
        changed = true;
      }
    }
    if (changed) {
      selectedGroupSegments.value = next;
    }
  },
  { immediate: true }
);

const groupLevels = computed(() =>
  Array.from({ length: maxGroupDepth.value }, (_, idx) => idx)
);

function setSelectedGroupSegment(level: number, value: string) {
  const next = [...selectedGroupSegments.value];
  next[level] = value || null;
  for (let idx = level + 1; idx < next.length; idx++) {
    next[idx] = null;
  }
  selectedGroupSegments.value = next;
}

const variableOptions = computed(() => {
  if (maxGroupDepth.value === 0) {
    return allVisibleVariables.value;
  }
  return allVisibleVariables.value.filter((varname) => {
    const segments = getGroupSegments(varname);
    return selectedGroupSegments.value.every((selected, idx) => {
      if (selected === null) {
        return true;
      }
      return segments[idx] === selected;
    });
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
  return label ? `${varname} - ${label}` : varname;
}
</script>

<template>
  <div class="column">
    <div class="control">
      <template v-for="level in groupLevels" :key="`group-${level}`">
        <label class="is-size-7 has-text-grey" :for="`group-level-${level}`">
          Group level {{ level + 1 }}
        </label>
        <div class="select is-fullwidth mb-2">
          <select
            :id="`group-level-${level}`"
            :value="selectedGroupSegments[level] ?? ''"
            class="form-control"
            :aria-label="`Group level ${level + 1}`"
            @change="
              setSelectedGroupSegment(
                level,
                ($event.target as HTMLSelectElement).value
              )
            "
          >
            <option
              v-for="group in groupOptionsByLevel[level]"
              :key="group"
              :value="group"
            >
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
        / {{ currentVarUnits }}
      </div>
    </div>
  </div>
</template>
