# Gridlook 2025-07-22

**ESM data viewer on a 3D sphere using WebGL**

Andrej Fast¹, Tobi Kölling², Fabian Wachsmann¹, Lukas Kluft²

¹DKRZ, ²MPI-M

🔗 [Github](https://github.com/d70-t/gridlook) - 🔗 [Demo](https://gridlook.pages.dev/)

---

## 🌍 Motivation

Build an easy-to-use **visualisation tool** to

make climate science more **explorable and tangible**.

---

## 🚀 Features

- 👀 show plotting without HPC
- 🔎 _Simply and Interactively explore_
  **native grid** Earth System Model (ESM) output
- 🔗 Share _any dataset view_ via URL
- 🚅💨 no installation or compute server required
- 🎨 _client-side_ rendering and color mapping
  **no image pregeneration**

---

## ☁️ Set-up

Support and leverage **any Zarr dataset** stored in cloud environments.

📌 **Recipe**:
`https://gridlook.pages.dev/#` + `ZARR_URI`

Where `ZARR_URI`:

- ✅ Is **openly accessible**
- 🌐 Allows **Cross-Origin Requests (CORS)**

---

## Gridlook is _Not_

- ❌ A competitor to high-end visualization suites
- ❌ A tool for generating publication-quality graphics<br>
  👉 It’s built for intuitive, efficient, interoperable **exploration**.

---

## 🛠 Technical Details

- 🧠 Built with **TypeScript**
- 🌱 Frontend: **Vue.js** + **Bulma**
- 🔺 Rendering: **Three.js (WebGL)**
- 📦 Zarr handling via **Zarrita** (with **icechunk-js** support for Icechunk stores)

---

## Supported Grids

- 🌐 Regular Grids
- 🧭 Rotated Regular Grids
- 💠 HEALPix
- 🔺 Triangular (ICON)
- 🪢 \* Irregular Grids
- 🌐 \* Gaussian Reduced (e.g., ERA5)

---

## 📊 Examples

**💠 Healpix**

Support for all datasets in the [WCRP Global Hackathon HK25 catalog](https://digital-earths-global-hackathon.github.io/catalog/).
Get to know the gridtype _healpix_
with this ICON amip Dyamond3 simulation PT6h_inst dataset:

- [Level 0](https://gridlook.pages.dev/#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/PT6H_inst_z0_atm)
- [Level 4](https://gridlook.pages.dev/#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/PT6H_inst_z4_atm)
- [Level 7](https://gridlook.pages.dev/#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/PT6H_inst_z7_atm)
- [Level 11](https://gridlook.pages.dev/#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/PT6H_inst_z11_atm) (downloads much data!)

---

👀 Many of the following datasets have large chunks (~100MB).

Mind that when you are on mobile network or using a mobile device.

---

2. [🔺 Triangular](https://gridlook.pages.dev/#https://eerie.cloud.dkrz.de/datasets/icon-esm-er.hist-1950.v20240618.atmos.native.2d_monthly_mean/stac)
   Dataset: EERIE ICON hist-1950 tas on R2B8 (10km)
3. [🌐 Regular (lat x lon)](https://gridlook.pages.dev/#https://storage.googleapis.com/cmip6/CMIP6/HighResMIP/EC-Earth-Consortium/EC-Earth3P-HR/highresSST-present/r1i1p1f1/Amon/pr/gr/v20170811/)
   Dataset: CMIP6 EC-Earth3P-HR highresSST-present pr, 30km.
   -> Support for CMIP
4. [🧭 Rotated lat x lon](https://gridlook.pages.dev/#https://euro-cordex.s3.amazonaws.com/CMIP5/cordex/output/EUR-11/GERICS/MPI-M-MPI-ESM-LR/historical/r3i1p1/REMO2015/v1/mon/tas/v20190925/)
   Dataset: CORDEX REMO2015 historical tas on EUR11(12km)
   -> Support for CORDEX
5. [🌐 Gaussian reduced (decreasing no of longitudes towards poles)](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://eerie.cloud.dkrz.de/datasets/ifs-amip-tco1279.hist.v20240901.atmos.native.2D_monthly/stac)
   Dataset: EERIE IFS hist 10fg on TCO1279 (10km)
   --> Support for ERA5
6. [🪢 Irregular](https://gridlook.pages.dev/#https://cmip6-pds.s3.amazonaws.com/CMIP6/CMIP/AWI/AWI-CM-1-1-MR/historical/r1i1p1f1/Oday/tos/gn/v20181218/)
   Dataset: CMIP6 AWI-CM-1-1-MR historical tos, 25km.

---

## 💡 Use Cases

- 📱 Embed in web apps — even works on mobile
- 🧬 Understand model internals
  (e.g., [ring-shaped precipitation in IFS](https://gridlook.pages.dev/#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/IFS-FESOM/hourly_healpix2048.zarr))
- 🐛 Find bugs or diagnose outputs
  (e.g., [Amazon River temperature anomaly in CMIP6 MPI-ESM1-2](https://gridlook.pages.dev/#https://storage.googleapis.com/cmip6/CMIP6/ScenarioMIP/DKRZ/MPI-ESM1-2-HR/ssp370/r1i1p1f1/Amon/tas/gn/v20190710/))

---

Precipitation rate in IFS Dyamond3 over the indian ocean
![Precipitation rate in IFS Dyamond3 over the indian ocean](assets/ifs_precip_ringshaped.jpg)

Cloud coverage in IFS Dyamond3 over the Pacific
![Cloud coverage in IFS Dyamond3 over the Pacific](assets/ifs_cloudcover.jpg)

---

## ☁️ Gridlook collections

**🧊 DKRZ support for S3 and Swift datasets**

STAC Integration as a DM test service:
Buttons as Assets in STAC Items

- [Dyamond3 Healpix](https://discover.dkrz.de/external/stac2.cloud.dkrz.de/fastapi/collections/dyamond)

---

**🧊 DKRZ support for S3 and Swift datasets**

works well for the HK25 data stored at DKRZ because of **a performant institutional s3 cloud storage**

---

**Prepared datasets**

works well for the HK25 data stored at DKRZ because we

- rechunked datasets
- enriched datasets (`crs`, attributes)
- brought it to cloud
- embedded links in catalogs

---

### ☁️ Other Cloud Providers

For CORS-enabled locations:

💡 Right-click `.zmetadata` to get the URL
→ append to Gridlook URL and remove `.zmetadata`
→ submit

- **Google Cloud**
  [CMIP6 Dataset](https://console.cloud.google.com/marketplace/product/noaa-public/cmip6)

- **AWS**
  [EURO-CORDEX Dataset](https://registry.opendata.aws/euro-cordex/)

- (**Azure**
  ❌ Not supported (e.g., [Planetary Computer](https://planetarycomputer.microsoft.com/dataset/gridmet)))

---

## BYODataset

_A minimal guide for DKRZ users:_

1. Make your dataset [CF](https://cfconventions.org/) conform for gridtype identification. Add
   - `grid_mapping` attribute used for _"rotated_lat_lon"_ and _"healpix"_
   - coordinates: `lat` and `lon` values
   - better not encode `time` as _"INT64"_
   - (`long_name` attribute to variables)

2. Store zarr datasets in DKRZ cloud storage: [swift](https://docs.dkrz.de/doc/datastorage/swift/index.html) (until 2026) and [s3](https://docs.dkrz.de/doc/datastorage/minio/index.html) soon.

```shell
cdo -f nczarr copy INPUT OUTPUT #reformat to zarr
module load swift #login
swift upload BUCKET OUTPUT
```

Without temporary output in Python with [swiftspec](https://github.com/fsspec/swiftspec)

```python
import xarray as xr
ds = xr.open_dataset(YOUR_DS_URI)
ds.to_zarr("swift://BUCKET/DS_NAME")
```

Example: [Fsspec intro](https://github.com/eerie-project/EERIE_hackathon_2023/blob/main/nereus/tutorial_cloud_fsspec.ipynb)(EERIE Hackathon 2023)

3. Bucket setting: Publish and allow CORS

```bash
swift post BUCKET -r .r:* #publish
swift post BUCKET -m \
  "X-Container-Meta-Access-Control-Allow-Origin:*" #set CORS
```

---

**Optimal Zarr-datasets for Web-Apps**:

Reduce the amount of transferred data.

- Chunks!
  - aim for 1-5 MB
  - are loaded in parallel (it's ok to load a few)
  - are _cached_ (on client-side usually only if smaller than 50MB)

- Compress it!
  - [zarrita supports common algorithms](https://github.com/manzt/zarrita.js/blob/c0dd684dc4da79a6f42ab2a591246947bde8d143/packages/zarrita/src/codecs.ts#L26)

---

🎯 makes **climate science more explorable and tangible**.
