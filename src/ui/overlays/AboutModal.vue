<script setup lang="ts">
import { ref } from "vue";

import Modal from "@/ui/common/Modal.vue";

const visible = ref(false);
</script>

<template>
  <Modal v-model="visible" title="About Gridlook">
    <p>
      This is a heavily modified fork of GridLook by EE Holmes (@eeholmes). 
      This fork is for experimentation and testing extensions of GridLook ideas for vizualization of icechunk, grouped Zarr, multilevel GeoZarr and polar data.
      https://github.com/eeholmes/gridlook
    </p>
    <br />
    <p>
      GridLook is a WebGL-based viewer for Earth system model (ESM) output. It
      supports cloud-hosted Zarr datasets and provides interactive grid
      visualization tools.
    </p>
    <br />
    <p>
      Developed by Max-Planck-Institute for Meteorology (MPI-M) and the German
      Climate Computing Center (DKRZ)
    </p>
    <p class="mt-3 is-size-7 has-text-grey">Earth texture credit: NASA.</p>
    <template #footer>
      <p>
        <a
          href="https://github.com/d70-t/gridlook"
          target="_blank"
          rel="noopener noreferrer"
          class="button is-link is-light"
        >
          <span class="icon">
            <i class="fa-brands fa-github"></i>
          </span>
          <span>View GridLook on GitHub</span>
        </a>
      </p>
    </template>
  </Modal>
  <button
    class="button is-info is-small"
    aria-label="About"
    type="button"
    @click="visible = true"
  >
    <span class="icon">
      <i class="fa-solid fa-circle-question"></i>
    </span>
    <span>About</span>
  </button>
</template>
