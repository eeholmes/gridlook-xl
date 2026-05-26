__PROJECTION_SHADER_FUNCTIONS__

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;

attribute vec2 latLon;  // lat, lon in degrees

varying vec2 vUv;

void main() {
  vUv = uv;
  vec3 projected = projectLatLon(
    latLon.x,
    latLon.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
