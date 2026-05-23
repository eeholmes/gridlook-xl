<script lang="ts" setup>
import { computed, ref } from "vue";

import type { TCatalogEntry } from "@/utils/catalog.ts";

const props = defineProps<{
  title?: string;
  datasets: TCatalogEntry[];
}>();

const emit = defineEmits<{
  select: [entry: TCatalogEntry];
}>();

const searchQuery = ref("");

const filterFormat = ref("all");
const filterAccess = ref("all");
const filterLayout = ref("all");
const filterGrid = ref("all");
const filterConvention = ref("all");
const filterCrs = ref("all");

const uniqueFormats = computed(() =>
  Array.from(
    new Set(props.datasets.map((d) => d.format).filter((v): v is string => !!v))
  ).sort()
);

const uniqueAccessTypes = computed(() =>
  Array.from(
    new Set(props.datasets.map((d) => d.access).filter((v): v is string => !!v))
  ).sort()
);

const uniqueLayouts = computed(() =>
  Array.from(
    new Set(props.datasets.map((d) => d.layout).filter((v): v is string => !!v))
  ).sort()
);

const uniqueGridTypes = computed(() =>
  Array.from(
    new Set(props.datasets.map((d) => d.grid).filter((v): v is string => !!v))
  ).sort()
);

const uniqueConventions = computed(() =>
  Array.from(
    new Set(
      props.datasets.map((d) => d.convention).filter((v): v is string => !!v)
    )
  ).sort()
);

const uniqueCrsTypes = computed(() =>
  Array.from(
    new Set(props.datasets.map((d) => d.crs).filter((v): v is string => !!v))
  ).sort()
);

const filteredAndSortedDatasets = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();

  return props.datasets.filter((entry) => {
    if (q) {
      const haystack = [
        entry.title ?? "",
        entry.url,
        entry.format ?? "",
        entry.access ?? "",
        entry.layout ?? "",
        entry.grid ?? "",
        entry.convention ?? "",
        entry.crs ?? "",
        entry.description ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) {
        return false;
      }
    }

    if (filterFormat.value !== "all" && entry.format !== filterFormat.value) {
      return false;
    }
    if (filterAccess.value !== "all" && entry.access !== filterAccess.value) {
      return false;
    }
    if (filterLayout.value !== "all" && entry.layout !== filterLayout.value) {
      return false;
    }
    if (filterGrid.value !== "all" && entry.grid !== filterGrid.value) {
      return false;
    }
    if (
      filterConvention.value !== "all" &&
      entry.convention !== filterConvention.value
    ) {
      return false;
    }
    if (filterCrs.value !== "all" && entry.crs !== filterCrs.value) {
      return false;
    }

    return true;
  });
});

function displayTitle(entry: TCatalogEntry): string {
  return entry.title ?? entry.url;
}

function select(entry: TCatalogEntry) {
  emit("select", entry);
}
</script>

<template>
  <nav class="catalog-panel mt-4 pt-2">
    <h2 class="catalog-title">
      {{ title ?? "Dataset Catalog" }}
    </h2>
    <div class="is-flex-direction-column my-3 w-100">
      <div class="control has-icons-left mb-2">
        <input
          v-model="searchQuery"
          class="input is-small"
          type="text"
          placeholder="Search datasets…"
        />
        <span class="icon is-left is-small">
          <i class="fa-solid fa-magnifying-glass"></i>
        </span>
      </div>
      <div
        class="is-flex is-align-items-center is-justify-content-space-between w-100 catalog-filters"
      >
        <span class="is-size-7 has-text-grey">
          {{ filteredAndSortedDatasets.length }} /
          {{ datasets.length }}
          dataset{{ datasets.length !== 1 ? "s" : "" }}
        </span>
        <div class="field is-grouped is-align-items-center mb-0">
          <div v-if="uniqueFormats.length > 0" class="control">
            <div class="select is-small">
              <select v-model="filterFormat" title="Filter by format">
                <option value="all">Format: All</option>
                <option v-for="v in uniqueFormats" :key="v" :value="v">
                  {{ v }}
                </option>
              </select>
            </div>
          </div>
          <div v-if="uniqueAccessTypes.length > 0" class="control">
            <div class="select is-small">
              <select v-model="filterAccess" title="Filter by access">
                <option value="all">Access: All</option>
                <option v-for="v in uniqueAccessTypes" :key="v" :value="v">
                  {{ v }}
                </option>
              </select>
            </div>
          </div>
          <div v-if="uniqueLayouts.length > 0" class="control">
            <div class="select is-small">
              <select v-model="filterLayout" title="Filter by layout">
                <option value="all">Layout: All</option>
                <option v-for="v in uniqueLayouts" :key="v" :value="v">
                  {{ v }}
                </option>
              </select>
            </div>
          </div>
          <div v-if="uniqueGridTypes.length > 0" class="control">
            <div class="select is-small">
              <select v-model="filterGrid" title="Filter by grid type">
                <option value="all">Grid: All</option>
                <option v-for="v in uniqueGridTypes" :key="v" :value="v">
                  {{ v }}
                </option>
              </select>
            </div>
          </div>
          <div v-if="uniqueConventions.length > 0" class="control">
            <div class="select is-small">
              <select v-model="filterConvention" title="Filter by convention">
                <option value="all">Convention: All</option>
                <option v-for="v in uniqueConventions" :key="v" :value="v">
                  {{ v }}
                </option>
              </select>
            </div>
          </div>
          <div v-if="uniqueCrsTypes.length > 0" class="control">
            <div class="select is-small">
              <select v-model="filterCrs" title="Filter by CRS">
                <option value="all">CRS: All</option>
                <option v-for="v in uniqueCrsTypes" :key="v" :value="v">
                  {{ v }}
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="catalog-entries">
      <p
        v-if="filteredAndSortedDatasets.length === 0"
        class="has-text-grey is-size-7"
      >
        No datasets match your search.
      </p>
      <button
        v-for="(entry, i) in filteredAndSortedDatasets"
        :key="entry.url + '-' + i"
        class="catalog-entry panel-block"
        type="button"
        @click="select(entry)"
      >
        <div class="catalog-entry-content">
          <div class="catalog-entry-header">
            <div class="catalog-entry-main">
              <span class="icon is-small has-text-link">
                <i class="fa-solid fa-database"></i>
              </span>
              <strong class="catalog-entry-title" :title="displayTitle(entry)">
                {{ displayTitle(entry) }}
              </strong>
            </div>
            <div class="catalog-entry-tags">
              <span v-if="entry.format" class="tag is-info is-light is-small">
                {{ entry.format }}
              </span>
              <span
                v-if="entry.access"
                class="tag is-warning is-light is-small"
              >
                {{ entry.access }}
              </span>
              <span v-if="entry.layout" class="tag is-light is-small">
                {{ entry.layout }}
              </span>
              <span v-if="entry.grid" class="tag is-link is-light is-small">
                {{ entry.grid }}
              </span>
              <span
                v-if="entry.convention"
                class="tag is-primary is-light is-small"
              >
                {{ entry.convention }}
              </span>
              <span v-if="entry.crs" class="tag is-success is-light is-small">
                {{ entry.crs }}
              </span>
            </div>
          </div>
          <p v-if="entry.description" class="help has-text-grey mt-1 mb-0">
            {{ entry.description }}
          </p>
          <p
            v-if="entry.title"
            class="help has-text-grey-light mt-1 mb-0 catalog-entry-url"
            :title="entry.url"
          >
            {{ entry.url }}
          </p>
        </div>
      </button>
    </div>
  </nav>
</template>

<style lang="scss" scoped>
.catalog-title {
  color: var(--bulma-label-color);
  display: block;
  font-size: var(--bulma-size-normal);
  font-weight: var(--bulma-weight-semibold);
}
.catalog-panel {
  margin-top: 1rem;
  max-height: 400px;
}

.catalog-entries {
  max-height: 45vh;
  overflow-y: auto;
  scrollbar-width: thin;
}

.catalog-entry {
  display: block !important;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  &:hover {
    background-color: var(--bulma-link-light) !important;
  }
  border-bottom: 1px solid var(--bulma-border) !important;
  &:last-child {
    border-bottom: none !important;
  }
}

.catalog-entry-content {
  width: 100%;
  min-width: 0;
}

.catalog-entry-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
}

.catalog-entry-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1 1 auto;
  min-width: 0;
}

.catalog-entry-header .tag {
  flex-shrink: 0;
}

.catalog-entry-tags {
  display: flex;
  flex-shrink: 0;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.catalog-filters {
  flex-wrap: wrap;
  gap: 0.25rem;
  row-gap: 0.25rem;
}

.catalog-entry-title {
  display: block;
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}

.catalog-entry-url {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
