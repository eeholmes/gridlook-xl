__PROJECTION_SHADER_FUNCTIONS__

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float pointSize;

attribute vec2 latLon;  // lat, lon in degrees
attribute float data_value;

varying float v_value;

void main() {
  v_value = data_value;
  vec3 projected = projectLatLon(
    latLon.x,
    latLon.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
  if (pointSize > 0.0) {
    gl_PointSize = pointSize;
  }
}
