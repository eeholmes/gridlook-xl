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
    if (is_nan(v_value) || v_value <= hideBelowValue) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);
    __APPLY_COLORMAP_SHADERS__
    gl_FragColor.a = 1.0;
}
