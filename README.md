# gridlook

This is a fork of [GridLook](https://github.com/d70-t/gridlook) is a WebGL-based viewer for cloud-hosted Zarr datasets. You can view any **CORS-enabled**, public Zarr dataset with GridLook. I have modified it to support Zarr v3 (better), Icechunk stores, and some number formating that it didn't support out of box. I also added a GitHub Action to server the gridlook viewer on GitHub Pages.

![](docs/assets/showcase.webp)

## Try out my fork:

https://eeholmes.github.io/gridlook.

## Try on your own Zarr store:

```
https://gridlook.pages.dev/#<ZARR_URI>
```

Gridlook can also load catalog JSON files that list multiple datasets. The catalog format and deployment options are documented in [docs/catalogs.md](docs/catalogs.md). A guide to the viewer keyboard, mouse, and touch interaction is available in [docs/Controls.md](docs/Controls.md).

## Project Setup

This project uses [Node.js](https://nodejs.org/en) and [vue.js](https://vuejs.org/)

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```

### Customize configuration

See [Vite Configuration Reference](https://vitejs.dev/config/).

## Usage

The project is served at http://localhost:3000/ when you run `npm run dev`.

## CORS & Hosting Notes

To load datasets from services like DKRZ Swift, ensure [CORS](https://developer.mozilla.org/de/docs/Web/HTTP/Guides/CORS) is enabled on the server.

Example for the nextGEMS container on Swift:

```
swift post nextGEMS -m "X-Container-Meta-Access-Control-Allow-Origin:*"
```

This allows GridLook to fetch data directly from the container in your browser.
