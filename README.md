# gridlook with IceChunk and grouping

This is a heavily modified fork of [GridLook](https://github.com/d70-t/gridlook) developed by the Max-Planck-Institute for Meteorology (MPI-M) and the German Climate Computing Center (DKRZ). GridLook is a WebGL-based viewer for cloud-hosted Zarr datasets. With GridLook can view any **CORS-enabled**, public Zarr dataset with GridLook if you have the dataset URL. See `/public/static/catalog.json` for lots of example URLs. I have modified GridLook to support grouped and multiscale Zarr v2 and v3, access via Icechunk using [icechunk-js](https://github.com/EarthyScience/icechunk-js), and more grids. I also added a GitHub Action to serve the viewer on GitHub Pages. **Credit**: Cite the GridLook team (MPI-M & DKRZ).

![](docs/assets/showcase.webp)

## Try out my modified viewer:

https://eeholmes.github.io/gridlook

Try on your own PUBLIC Zarr or Icechunk store:

See the `public/static/catelog.json` file for examples. No authentication layer and CORS must be enabled.

```
https://eeholmes.github.io/gridlook/#<STORE_URI>
```

## Create your own viewer hosted on GitHub Pages

1. For my repo
2. Set-up GitHub Pages `https://github.com/<username or org>/gridlook/settings/pages` to use GitHub Actions. And your viewer will be live at the url it shows.

<img width="935" height="320" alt="image" src="https://github.com/user-attachments/assets/7cbf0169-a38c-4c90-9770-a04e11ee20a4" />

Edit the `public/static/catalog.json` to create your own catalog that you reach by clicking the folder icon in top left. 

## Lots of Zarr Examples

Click on the folder icon in the top left. You can sort examples using format, access pattern, layout and grid. You can copy the URLs too.

### `format`

The `format` field describes the format that Gridlook actually reads and serves to the client. Currently this is `Zarr v2` or `Zarr v3`, even if the dataset originally came from NetCDF, GRIB, or another source format.  For example, an Icechunk repository may have been created from thousands of NetCDF files, but the client is still reading a Zarr hierarchy through the Icechunk access layer. In that case the format is still considered `Zarr v3`.

### `access`

The `access` field describes how the dataset is accessed or virtualized. A value of `direct` means the client is reading the dataset directly from object storage or HTTP as a normal Zarr store. Other values describe virtualization or transactional layers built on top of Zarr.

Examples:
- `direct` — standard object store or HTTP access
- `icechunk` — transactional/versioned access using Icechunk
- `kerchunk` — *to be added later* virtual references to existing files such as NetCDF or GRIB
- `virtualizarr` — *to be added later* virtualized Zarr mappings

### `layout`

The `layout` field describes how arrays are organized within the dataset.

#### `simple`

A `simple` dataset contains a single-resolution dataset with one primary array layout. This is the most common type of Zarr store written directly from xarray or similar tools.

#### `grouped`

A `grouped` dataset contains multiple groups or subdatasets organized hierarchically. The groups may represent variables, experiments, ensemble members, model runs, or categories of data. Examples Zarr with multiple datasets and grouped scientific collections.

#### `multiscale`

A `multiscale` dataset is a pyramid containing multiple resolutions of the same data. Lower-resolution overview layers are included to support fast visualization, zooming, and progressive rendering. Multiscale datasets are commonly produced by GeoZarr workflows and visualization pipelines.

The important distinction is that:
- a `grouped` dataset organizes different datasets
- a `multiscale` dataset organizes different resolutions of the same dataset

A multiscale dataset is often internally grouped, but the groups specifically represent resolution levels.

Examples include:
- GeoZarr pyramids
- image pyramids
- multiresolution ocean model outputs

### `grid`

The `grid` field describes the spatial grid topology or projection used by the dataset. This is mostly guessed at the moment. Don't read too much into this.

Examples:
- `regular` — standard latitude/longitude rectilinear grid
- `curvilinear` — warped 2D latitude/longitude grid
- `irregular` — nonuniform or unstructured coordinates
- `healpix` — HEALPix hierarchical equal-area grid
- `triangular` — triangular mesh such as ICON model grids
- `polar_stereographic`
- `utm`

---

### `convention`

The `convention` field describes optional higher-level metadata conventions layered on top of the storage format. A standard Zarr dataset may have no convention at all. In that case this field can be omitted or set to `null`. I wouldn't assume the 'convention' information is correct as I made a lot of guesses.

Examples:
- `GeoZarr` — geospatial conventions for Zarr datasets
- `OME-Zarr` — conventions for microscopy and bioimaging datasets

---

### `crs`

The `crs` field defines the coordinate reference system used by the dataset. This is definitely full of guesses!

Examples:
- `EPSG:4326` — WGS84 geographic coordinates
- `EPSG:3031` — Antarctic polar stereographic
- `EPSG:32637` — UTM zone 37N

## Developers

See `CONTRIBUTING.md` for instructions for running a local version. It is easy. **Credit**: Cite the GridLook team (MPI-M & DKRZ).

## CORS & Hosting Notes

To load datasets, you need to ensure [CORS](https://developer.mozilla.org/de/docs/Web/HTTP/Guides/CORS) is enabled on the server. If it is not, you might be out of luck unless you do something like make an icechunk version and host that someplace with CORS enabled (e.g. Source Coop).

**Checking Whether a Dataset URL is CORS Enabled**

Gridlook loads datasets directly from the browser, so the dataset URL must allow Cross-Origin Resource Sharing (CORS). If CORS is not enabled, browsers will block requests even if the dataset itself is publicly accessible.

A quick way to test this is with `curl`.

Run:

```bash
curl -I <URL>
```

For example:

```bash
curl -I https://storage.googleapis.com/nmfs_odp_nwfsc/CB/fish-pace-datasets/chla-z/zarr/zarr.json
```

A CORS-enabled response will usually include headers like:

```text
Access-Control-Allow-Origin: *
```

or:

```text
Access-Control-Allow-Origin: https://your-site.org
```

If this header is missing, browsers will likely block access to the dataset.

### Notes

- Public accessibility does not automatically mean CORS is enabled.
- Object storage systems such as S3, GCS, Cloudflare R2, and Azure Blob Storage usually require separate CORS configuration.
- Icechunk repositories must also expose CORS headers on the underlying HTTP endpoints.
- Some datasets allow access to top-level metadata files but block chunk requests due to incomplete CORS settings.
