import * as THREE from "three";

import {
  projectionShaderFunctions,
  PROJECTION_TYPE_BY_MODE,
  getProjectionTypeFromMode,
} from "../projection/projectionShaders.ts";
import {
  PROJECTION_TYPES,
  type ProjectionHelper,
} from "../projection/projectionUtils.ts";

import {
  applyColormapShaders,
  availableColormaps,
  colormapShaders,
  type TColorMap,
} from "./colormapShaders.ts";
import compressedLutFragmentShaderSource from "./glsl/compressedLut.frag.glsl?raw";
import gpuProjectedMeshVertexShaderSource from "./glsl/gpuProjectedMesh.vert.glsl?raw";
import gpuProjectedPointVertexShaderSource from "./glsl/gpuProjectedPoint.vert.glsl?raw";
import gpuProjectedTextureVertexShaderSource from "./glsl/gpuProjectedTexture.vert.glsl?raw";
import pointFalloffFragmentShaderSource from "./glsl/pointFalloff.frag.glsl?raw";
import scalarColormapFragmentShaderSource from "./glsl/scalarColormap.frag.glsl?raw";
import screenQuadValueVertexShader from "./glsl/screenQuadValue.vert.glsl?raw";
import textureColormapFragmentShaderSource from "./glsl/textureColormap.frag.glsl?raw";

const isNaNGLSL = `
bool is_nan(float val) {
    uint bits = floatBitsToUint(val);
    // exponent all 1s (0x7F800000) AND non-zero mantissa = NaN
    // exponent all 1s AND zero mantissa = Infinity (not NaN)
    return (bits & 0x7F800000u) == 0x7F800000u && (bits & 0x007FFFFFu) != 0u;
}
`;

const posterizeGLSL = `
float posterize(float value, float levels) {
    if (levels > 1.0) {
        float step = floor(value * levels);
        step = min(step, levels - 1.0);  // Prevent overflow at max value
        return step / (levels - 1.0);
    }
    return value;
}
`;

function replaceShaderSections(
  shaderSource: string,
  extraReplacements: Record<string, string> = {}
) {
  return Object.entries({
    __COLORMAP_SHADERS__: colormapShaders.trim(),
    __IS_NAN_GLSL__: isNaNGLSL.trim(),
    __POSTERIZE_GLSL__: posterizeGLSL.trim(),
    __APPLY_COLORMAP_SHADERS__: applyColormapShaders.trim(),
    __PROJECTION_SHADER_FUNCTIONS__: projectionShaderFunctions.trim(),
    ...extraReplacements,
  }).reduce((shader, [needle, replacement]) => {
    return shader.replaceAll(needle, replacement);
  }, shaderSource);
}

const textureColormapFragmentShader = replaceShaderSections(
  textureColormapFragmentShaderSource
);

// credits: https://www.shadertoy.com/view/3lBXR3
//          https://github.com/mzucker/fit_colormaps
const scalarColormapFragmentShader = replaceShaderSections(
  scalarColormapFragmentShaderSource
);

const pointFalloffFragmentShader = replaceShaderSections(
  pointFalloffFragmentShaderSource
);

const compressedLutFragmentShader = replaceShaderSections(
  compressedLutFragmentShaderSource
);

// =============================================================================
// GPU-Projected Shaders
// =============================================================================
// These shaders perform map projection on the GPU, allowing instant center
// changes without geometry rebuilds.

/**
 * Vertex shader for GPU-projected texture-based rendering (Regular/HEALPix grids).
 * Takes lat/lon as attributes and projects them on the GPU.
 */
const gpuProjectedTextureVertexShader = replaceShaderSections(
  gpuProjectedTextureVertexShaderSource
);

/**
 * Vertex shader for GPU-projected mesh-based rendering (Triangular/Curvilinear/Gaussian grids).
 * Takes lat/lon as attributes and projects them on the GPU.
 */
const gpuProjectedMeshVertexShader = replaceShaderSections(
  gpuProjectedMeshVertexShaderSource
);

/**
 * Vertex shader for GPU-projected point clouds (Irregular grids).
 */
const gpuProjectedPointVertexShader = replaceShaderSections(
  gpuProjectedPointVertexShaderSource
);

export function makeCompressedColormapLutMaterial(
  colormap: TColorMap = "turbo",
  addOffset: 0 | 1,
  scaleFactor: 1 | -1
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      colormap: { value: availableColormaps[colormap] },
      posterizeLevels: { value: 0.0 },
      selLow: { value: 0.0 },
      selHigh: { value: 1.0 },
    },
    vertexShader: screenQuadValueVertexShader,
    fragmentShader: compressedLutFragmentShader,
  });
  return material;
}

export function getColormapScaleOffset(
  low: number,
  high: number,
  invertColormap: boolean
) {
  let addOffset: number;
  let scaleFactor: number;

  // Handle edge case where min equals max (single value dataset)
  if (high === low) {
    addOffset = 0.5;
    scaleFactor = 0.0;
    return { addOffset, scaleFactor };
  }

  if (invertColormap) {
    scaleFactor = -1 / (high - low);
    addOffset = -high * scaleFactor;
  } else {
    scaleFactor = 1 / (high - low);
    addOffset = -low * scaleFactor;
  }
  return { addOffset, scaleFactor };
}

/**
 * Create a GPU-projected texture material for Regular/HEALPix grids.
 * Projection is done on the GPU, allowing instant center changes.
 */
export function makeGpuProjectedTextureMaterial(
  texture: THREE.Texture,
  colormap: TColorMap = "turbo",
  addOffset: number,
  scaleFactor: number
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      colormap: { value: availableColormaps[colormap] },
      posterizeLevels: { value: 0.0 },
      hideBelowValue: { value: -1e38 },
      data: { value: texture },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
    },
    transparent: true,
    vertexShader: gpuProjectedTextureVertexShader,
    fragmentShader: textureColormapFragmentShader,
  });
  return material;
}

/**
 * Create a GPU-projected mesh material for vertex-valued grids.
 * Projection is done on the GPU, allowing instant center changes.
 */
export function makeGpuProjectedMeshMaterial(
  colormap: TColorMap = "turbo",
  addOffset: 1.0 | 0.0 = 0.0,
  scaleFactor: -1.0 | 1.0 = 1.0
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      pointSize: { value: 0.0 },
      colormap: { value: availableColormaps[colormap] },
      posterizeLevels: { value: 0.0 },
      hideBelowValue: { value: -1e38 },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
    },
    transparent: true,
    vertexShader: gpuProjectedMeshVertexShader,
    fragmentShader: scalarColormapFragmentShader,
  });
  return material;
}

/**
 * Create a GPU-projected point material for irregular grids.
 * Projection is done on the GPU, allowing instant center changes.
 */
export function makeGpuProjectedPointMaterial(
  colormap: TColorMap = "turbo",
  addOffset: 1.0 | 0.0 = 0.0,
  scaleFactor: -1.0 | 1.0 = 1.0
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      basePointSize: { value: 5.0 },
      minPointSize: { value: 1.0 },
      maxPointSize: { value: 10.0 },
      posterizeLevels: { value: 0.0 },
      hideBelowValue: { value: -1e38 },
      colormap: { value: availableColormaps[colormap] },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    vertexShader: gpuProjectedPointVertexShader,
    fragmentShader: pointFalloffFragmentShader,
  });
  return material;
}

/**
 * Update projection uniforms on a GPU-projected material.
 * This is the fast path - no geometry rebuild needed.
 */
export function updateProjectionUniforms(
  material: THREE.ShaderMaterial,
  projectionHelper: Pick<ProjectionHelper, "type" | "center">,
  radius: number = 1.0
) {
  const projectionTypeId = getProjectionTypeFromMode(projectionHelper.type);
  if (material.uniforms.projectionType) {
    material.uniforms.projectionType.value = projectionTypeId;
  }
  if (material.uniforms.centerLon) {
    material.uniforms.centerLon.value = projectionHelper.center.lon;
  }
  if (material.uniforms.centerLat) {
    material.uniforms.centerLat.value = projectionHelper.center.lat;
  }
  if (material.uniforms.projectionRadius) {
    material.uniforms.projectionRadius.value = radius;
  }
  material.depthTest =
    projectionHelper.type === PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;
}
