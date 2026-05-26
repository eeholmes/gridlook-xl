__COLORMAP_SHADERS__

__IS_NAN_GLSL__

__POSTERIZE_GLSL__

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float selLow;
uniform float selHigh;

void main() {
    if (v_value < selLow || v_value > selHigh) {
        // Sample the colormap at its minimum or maximum edge color
        float t_edge = v_value < selLow ? 0.0 : 1.0;
        float normalized_value = clamp(addOffset + scaleFactor * t_edge, 0.0, 1.0);
        normalized_value = posterize(normalized_value, posterizeLevels);
        __APPLY_COLORMAP_SHADERS__
        gl_FragColor.a = 1.0;
        return;
    }
    float range = max(selHigh - selLow, 0.0001);
    float t = (v_value - selLow) / range;
    float normalized_value = clamp(addOffset + scaleFactor * t, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);
    __APPLY_COLORMAP_SHADERS__
    gl_FragColor.a = 1.0;
}
