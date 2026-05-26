__COLORMAP_SHADERS__

__IS_NAN_GLSL__

__POSTERIZE_GLSL__

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float hideBelowValue;

void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;

    // Normalize scalar value for color mapping
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);
    float r2 = dot(uv, uv);
    // Soft circular splat using Gaussian falloff
    float falloff = exp(-r2 * 2.0); // Adjust the 4.0 as needed (sharpness)
    if (falloff < 0.01) discard; // Optional: discard transparent fragments


    if (is_nan(v_value) || v_value <= hideBelowValue) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }

    __APPLY_COLORMAP_SHADERS__
    gl_FragColor.a = falloff;
}
