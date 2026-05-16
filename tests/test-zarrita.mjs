// test-zarrita.mjs
// This shows how to read in my Zarr stores and test. The time for v3 shows an error FAILED time: dataType.match is not a function
import * as zarr from "zarrita";
import { performance } from "node:perf_hooks";

const STORES = [
  {
    label: "v3 chla-z",
    version: 3,
    url: "https://storage.googleapis.com/nmfs_odp_nwfsc/CB/fish-pace-datasets/chla-z/zarr",
    dataVar: "CHLA",
    coords: ["lat", "lon", "z", "time"],
  },
  {
    label: "v2 mind-the-chl-gap IO",
    version: 2,
    url: "https://storage.googleapis.com/nmfs_odp_nwfsc/CB/mind_the_chl_gap/IO.zarr/",
    dataVar: "CHL",
    coords: ["lat", "lon", "time"],
  },
];

async function time(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const t1 = performance.now();
  console.log(`${label}: ${((t1 - t0) / 1000).toFixed(3)} sec`);
  return result;
}

async function maybeConsolidate(store) {
  try {
    return await zarr.withMaybeConsolidatedMetadata(store);
  } catch (err) {
    console.log(`metadata wrapper failed: ${err.message}`);
    return store;
  }
}

async function testStore({ label, version, url, dataVar, coords }) {
  console.log(`\n=== ${label} ===`);
  console.log(url);

  const open = version === 3 ? zarr.open.v3 : zarr.open.v2;

  const rawStore = new zarr.FetchStore(url);

  const store = await time("metadata wrapper", () => maybeConsolidate(rawStore));

  const root = await time("open root group", () =>
    open(store, { kind: "group" })
  );

  const names = [...coords, dataVar];

  for (const name of names) {
    try {
      const arr = await time(`open array ${name}`, () =>
        open(root.resolve(name), { kind: "array" })
      );

      console.log(`${name}: shape=${JSON.stringify(arr.shape)} dtype=${arr.dtype}`);

      const selection =
        arr.shape.length === 1
          ? [zarr.slice(0, Math.min(5, arr.shape[0]))]
          : arr.shape.map((n) => zarr.slice(0, Math.min(1, n)));

      await time(`read tiny data ${name}`, () =>
        zarr.get(arr, selection)
      );
    } catch (err) {
      console.log(`FAILED ${name}: ${err.message}`);
    }
  }
}

for (const store of STORES) {
  await testStore(store);
}