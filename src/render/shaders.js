// GLSL for the WebGL2 compositor. Every intermediate texture holds
// premultiplied alpha with row 0 at the bottom of the frame.

export const VS_QUAD = `#version 300 es
in vec2 a_pos;
uniform mat3 u_mat;      // local quad (0..1) -> clip space
out vec2 v_local;        // 0..1 across the drawn quad, y down
void main() {
  v_local = a_pos;
  vec3 p = u_mat * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const VS_FULL = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;           // 0..1, y up (texture space of FBOs)
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const COLOR_FN = `
uniform float u_exposure, u_contrast, u_saturation, u_vibrance, u_temperature, u_tint;
uniform float u_highlights, u_shadows, u_whites, u_blacks, u_fade, u_hue;
uniform sampler2D u_curves; uniform bool u_useCurves;
uniform mediump sampler3D u_lut; uniform bool u_useLut; uniform float u_lutMix; uniform float u_lutSize;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

vec3 grade(vec3 c) {
  c *= exp2(u_exposure);
  c *= vec3(1.0 + u_temperature * 0.12 - u_tint * 0.02, 1.0 + u_tint * 0.1, 1.0 - u_temperature * 0.12 - u_tint * 0.02);
  float l = luma(c);
  float sh = 1.0 - smoothstep(0.0, 0.55, l);
  float hi = smoothstep(0.45, 1.0, l);
  c += c * u_shadows * 0.6 * sh;
  c += (1.0 - c) * max(u_highlights, 0.0) * 0.35 * hi + c * min(u_highlights, 0.0) * 0.45 * hi;
  c = (c - u_blacks * -0.08) / max(0.2, 1.0 + u_blacks * 0.08 - u_whites * 0.15);
  c = (c - 0.5) * (1.0 + u_contrast) + 0.5;
  c = max(c, 0.0);
  float l2 = luma(c);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx - mn;
  c = mix(vec3(l2), c, 1.0 + u_saturation);
  c = mix(vec3(luma(c)), c, 1.0 + u_vibrance * (1.0 - sat) * 1.2);
  if (u_hue != 0.0) c = hueRotate(c, u_hue * 3.14159265);
  c = clamp(c, 0.0, 1.0);
  if (u_useCurves) {
    c = vec3(texture(u_curves, vec2(c.r, 0.5)).r, texture(u_curves, vec2(c.g, 0.5)).g, texture(u_curves, vec2(c.b, 0.5)).b);
    c = vec3(texture(u_curves, vec2(c.r, 0.5)).a, texture(u_curves, vec2(c.g, 0.5)).a, texture(u_curves, vec2(c.b, 0.5)).a);
  }
  if (u_useLut) {
    vec3 lc = c * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize;
    c = mix(c, texture(u_lut, lc).rgb, u_lutMix);
  }
  c = mix(c, c * 0.82 + 0.1, u_fade);
  return clamp(c, 0.0, 1.0);
}
`;

// Draws one source (video frame, image, text canvas) into a project-sized layer.
export const FS_LAYER = `#version 300 es
precision highp float;
in vec2 v_local;
out vec4 o;
uniform sampler2D u_src;
uniform int u_mode;            // 0 texture, 1 solid colour, 2 gradient, 3 texture already premultiplied
uniform vec4 u_color, u_color2; uniform float u_gradAngle;
uniform vec4 u_uvRect;         // x0,y0,x1,y1 of the source to sample (0..1, y down)
uniform int u_packed;          // 0 none, 1 alpha in bottom half, 2 alpha in right half
uniform bool u_flipX, u_flipY;
uniform float u_opacity;
uniform vec2 u_texel;          // 1 / source size
uniform float u_sharpen;
uniform vec2 u_res;            // layer size in pixels
uniform float u_time;
uniform float u_grain, u_vignette, u_chromatic, u_pixelate;
uniform bool u_chroma; uniform vec3 u_chromaColor; uniform float u_chromaSim, u_chromaSmooth, u_chromaSpill;
uniform int u_maskType;        // 0 none,1 rect,2 ellipse,3 wipe
uniform vec4 u_mask;           // cx, cy, w, h in local 0..1
uniform float u_maskRadius, u_maskAngle, u_maskFeather, u_maskPos; uniform bool u_maskInvert;
uniform bool u_maskLine; uniform vec4 u_maskLineColor; uniform float u_maskLineWidth;
uniform sampler2D u_maskTex; uniform vec2 u_maskOff;
uniform bool u_depthOn; uniform sampler2D u_depth; uniform vec2 u_depthShift; uniform float u_depthZoom, u_depthFocus, u_depthMargin;
uniform float u_wipe;          // animation wipe 0..1
uniform float u_letterbox;
uniform bool u_mirror;
uniform bool u_grade;
uniform vec4 u_localRect;     // crop region of the full frame covered by this quad
${COLOR_FN}

vec2 srcUV(vec2 l) {
  vec2 p = l;
  if (u_mirror && p.x > 0.5) p.x = 1.0 - p.x;
  if (u_flipX) p.x = 1.0 - p.x;
  if (u_flipY) p.y = 1.0 - p.y;
  return mix(u_uvRect.xy, u_uvRect.zw, p);
}

vec4 fetch(vec2 uv) {
  if (u_packed == 1) {
    vec3 c = texture(u_src, vec2(uv.x, uv.y * 0.5)).rgb;
    float a = texture(u_src, vec2(uv.x, 0.5 + uv.y * 0.5)).r;
    return vec4(c, a);
  }
  if (u_packed == 2) {
    vec3 c = texture(u_src, vec2(uv.x * 0.5, uv.y)).rgb;
    float a = texture(u_src, vec2(0.5 + uv.x * 0.5, uv.y)).r;
    return vec4(c, a);
  }
  vec4 t = texture(u_src, uv);
  if (u_mode == 3 && t.a > 0.0) t.rgb /= t.a;
  return t;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// Moving photo: a source point at depth d (1 near, 0 far) shows at
// c + (src - c) * (1 + zoom * d) * (1 + margin) + shift * (d - focus).
// Solved for src with a few fixed-point steps.
vec2 depthUV(vec2 s) {
  vec2 c = vec2(0.5);
  vec2 p = s;
  for (int i = 0; i < 8; i++) {
    float d = texture(u_depth, clamp(p, 0.0, 1.0)).r;
    p = c + (s - c - u_depthShift * (d - u_depthFocus)) / ((1.0 + u_depthZoom * d) * (1.0 + u_depthMargin));
  }
  return clamp(p, 0.0, 1.0);
}

float maskValue(vec2 l) {
  if (u_maskType == 0) return 1.0;
  float v = 1.0;
  float f = max(u_maskFeather, 0.0005);
  if (u_maskType == 4) {
    vec2 q = l - u_maskOff;
    v = (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) ? 0.0 : texture(u_maskTex, q).r;
  } else if (u_maskType == 3) {
    float a = radians(u_maskAngle);
    vec2 dir = vec2(cos(a), sin(a));
    float d = dot(l - 0.5, dir) + 0.5 - u_maskPos;
    v = 1.0 - smoothstep(-f, f, d);
  } else {
    vec2 c = u_mask.xy; vec2 hs = max(u_mask.zw * 0.5, vec2(1e-4));
    float a = radians(u_maskAngle);
    vec2 p = l - c;
    p = vec2(cos(a) * p.x + sin(a) * p.y, -sin(a) * p.x + cos(a) * p.y);
    if (u_maskType == 2) {
      float d = length(p / hs) - 1.0;
      v = 1.0 - smoothstep(-f * 4.0, f * 4.0, d);
    } else {
      vec2 q = abs(p) - hs + u_maskRadius;
      float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_maskRadius;
      v = 1.0 - smoothstep(-f, f, d);
    }
  }
  return u_maskInvert ? 1.0 - v : v;
}

void main() {
  vec4 col;
  vec2 fl = mix(u_localRect.xy, u_localRect.zw, v_local);
  if (u_mode == 1) {
    col = u_color;
  } else if (u_mode == 2) {
    float a = radians(u_gradAngle);
    float t = clamp(dot(v_local - 0.5, vec2(sin(a), -cos(a))) + 0.5, 0.0, 1.0);
    col = mix(u_color, u_color2, t);
  } else {
    vec2 l = fl;
    if (u_pixelate > 0.0) {
      vec2 cells = max(vec2(4.0), u_res / max(1.0, u_pixelate * 60.0));
      l = (floor(l * cells) + 0.5) / cells;
    }
    vec2 uv = srcUV(l);
    if (u_depthOn) uv = depthUV(uv);
    col = fetch(uv);
    if (u_chromatic > 0.0) {
      vec2 off = (l - 0.5) * u_chromatic * 0.02;
      col.r = fetch(srcUV(l + off)).r;
      col.b = fetch(srcUV(l - off)).b;
    }
    if (u_sharpen > 0.0) {
      vec3 n = fetch(uv + vec2(u_texel.x, 0.0)).rgb + fetch(uv - vec2(u_texel.x, 0.0)).rgb + fetch(uv + vec2(0.0, u_texel.y)).rgb + fetch(uv - vec2(0.0, u_texel.y)).rgb;
      col.rgb = clamp(col.rgb + (col.rgb * 4.0 - n) * u_sharpen * 0.6, 0.0, 1.0);
    }
    if (u_chroma) {
      float cb = dot(col.rgb, vec3(-0.169, -0.331, 0.5)) - dot(u_chromaColor, vec3(-0.169, -0.331, 0.5));
      float cr = dot(col.rgb, vec3(0.5, -0.419, -0.081)) - dot(u_chromaColor, vec3(0.5, -0.419, -0.081));
      float d = length(vec2(cb, cr));
      float k = smoothstep(u_chromaSim * 0.3, u_chromaSim * 0.3 + u_chromaSmooth * 0.3 + 0.001, d);
      col.a *= k;
      // remove the key colour's spill from edges
      float spill = clamp(1.0 - k, 0.0, 1.0) * u_chromaSpill;
      float lum = luma(col.rgb);
      col.rgb = mix(col.rgb, vec3(lum), spill);
    }
    if (u_grade) col.rgb = grade(col.rgb);
    if (u_vignette != 0.0) {
      float d = length((fl - 0.5) * vec2(1.0, u_res.y / u_res.x));
      col.rgb *= 1.0 - u_vignette * smoothstep(0.25, 0.85, d);
    }
    if (u_grain > 0.0) {
      float g = hash(v_local * u_res + fract(u_time * 7.13) * 100.0) - 0.5;
      col.rgb += g * u_grain * 0.25;
    }
  }
  float a = col.a * u_opacity * maskValue(fl);
  if (u_wipe < 1.0) a *= step(v_local.x, u_wipe);
  if (u_letterbox > 0.0) {
    float fy = gl_FragCoord.y / u_res.y;
    float bar = u_letterbox * 0.5;
    if (fy < bar || fy > 1.0 - bar) { col.rgb = vec3(0.0); a = max(a, u_opacity); }
  }
  vec3 rgb = clamp(col.rgb, 0.0, 1.0);
  if (u_maskLine && u_maskType == 3) {
    float ang = radians(u_maskAngle);
    vec2 dir = vec2(cos(ang), sin(ang));
    float d = abs(dot(fl - 0.5, dir) + 0.5 - u_maskPos) * u_res.x;
    float lw = u_maskLineWidth * 0.5;
    if (d < lw) { rgb = u_maskLineColor.rgb; a = max(a, u_maskLineColor.a * u_opacity); }
  }
  o = vec4(rgb * a, a);
}`;

// Grades an existing premultiplied texture (adjustment layers).
export const FS_ADJUST = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform float u_amount;
uniform vec2 u_res;
uniform float u_time, u_grain, u_vignette, u_letterbox;
${COLOR_FN}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 s = texture(u_src, v_uv);
  vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 g = grade(c);
  float d = length((v_uv - 0.5) * vec2(1.0, u_res.y / u_res.x));
  g *= 1.0 - u_vignette * smoothstep(0.25, 0.85, d);
  if (u_grain > 0.0) g += (hash(v_uv * u_res + fract(u_time * 7.13) * 100.0) - 0.5) * u_grain * 0.25;
  c = mix(c, clamp(g, 0.0, 1.0), u_amount);
  float a = s.a;
  if (u_letterbox > 0.0) {
    float bar = u_letterbox * 0.5 * u_amount;
    if (v_uv.y < bar || v_uv.y > 1.0 - bar) { c = vec3(0.0); a = 1.0; }
  }
  o = vec4(c * a, a);
}`;

export const FS_COPY = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec4 u_bg;
uniform bool u_opaque;
void main() {
  vec4 s = texture(u_src, v_uv);
  o = u_opaque ? vec4(s.rgb + u_bg.rgb * (1.0 - s.a), 1.0) : s;
}`;

export const FS_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_dir;      // texel step * direction
uniform float u_sigma;   // in taps
void main() {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -8; i <= 8; i++) {
    float x = float(i);
    float w = exp(-(x * x) / (2.0 * u_sigma * u_sigma));
    acc += texture(u_src, v_uv + u_dir * x) * w;
    wsum += w;
  }
  o = acc / wsum;
}`;

export const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform int u_blend;  // 0 normal 1 multiply 2 screen 3 overlay 4 add 5 darken 6 lighten 7 softlight
uniform float u_amount;
vec3 blendf(vec3 b, vec3 s) {
  if (u_blend == 1) return b * s;
  if (u_blend == 2) return b + s - b * s;
  if (u_blend == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (u_blend == 4) return min(b + s, 1.0);
  if (u_blend == 5) return min(b, s);
  if (u_blend == 6) return max(b, s);
  if (u_blend == 7) return mix(2.0 * b * s + b * b * (1.0 - 2.0 * s), sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s), step(0.5, s));
  return s;
}
void main() {
  vec4 d = texture(u_dst, v_uv);
  vec4 s = texture(u_src, v_uv) * u_amount;
  if (u_blend == 0) { o = s + d * (1.0 - s.a); return; }
  vec3 cb = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 B = blendf(cb, cs);
  vec3 rgb = (1.0 - d.a) * s.rgb + (1.0 - s.a) * d.rgb + s.a * d.a * B;
  o = vec4(rgb, s.a + d.a * (1.0 - s.a));
}`;

export const FS_ADD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_amount;
void main() {
  vec4 a = texture(u_a, v_uv);
  vec4 b = texture(u_b, v_uv);
  o = vec4(min(a.rgb + b.rgb * u_amount, 1.0), max(a.a, min(1.0, b.a * u_amount)));
}`;

export const FS_TRANSITION = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_ab;   // blurred mix, used by the blur transition
uniform float u_p;
uniform int u_type;
uniform vec2 u_res;
vec4 A(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(u_a, uv); }
vec4 B(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(u_b, uv); }
float ease(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
void main() {
  float p = clamp(u_p, 0.0, 1.0);
  float e = ease(p);
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  if (u_type == 0) { o = mix(A(uv), B(uv), p); return; }                                  // dissolve
  if (u_type == 1) { o = p < 0.5 ? A(uv) * (1.0 - p * 2.0) + vec4(0,0,0,1) * p * 2.0 : B(uv) * (p * 2.0 - 1.0) + vec4(0,0,0,1) * (2.0 - p * 2.0); return; } // dip black
  if (u_type == 2) { vec4 w = vec4(1.0); o = p < 0.5 ? mix(A(uv), w, p * 2.0) : mix(w, B(uv), p * 2.0 - 1.0); return; } // dip white
  if (u_type == 3) { o = A(uv + vec2(e, 0.0)) + B(uv + vec2(e - 1.0, 0.0)); return; }      // push left
  if (u_type == 4) { o = A(uv - vec2(e, 0.0)) + B(uv - vec2(e - 1.0, 0.0)); return; }      // push right
  if (u_type == 5) { o = A(uv - vec2(0.0, e)) + B(uv - vec2(0.0, e - 1.0)); return; }      // push up
  if (u_type == 6) { o = A(uv + vec2(0.0, e)) + B(uv + vec2(0.0, e - 1.0)); return; }      // push down
  if (u_type == 7) { float s = smoothstep(e - 0.03, e + 0.03, 1.0 - uv.x); o = mix(B(uv), A(uv), s); return; } // wipe left
  if (u_type == 8) { float s = smoothstep(e - 0.03, e + 0.03, uv.x); o = mix(B(uv), A(uv), s); return; }     // wipe right
  if (u_type == 9) {                                                                          // zoom in
    vec2 za = (uv - 0.5) / (1.0 + e * 1.5) + 0.5;
    vec2 zb = (uv - 0.5) / (0.6 + e * 0.4) + 0.5;
    o = mix(A(za), B(zb), smoothstep(0.35, 0.75, p)); return;
  }
  if (u_type == 10) {                                                                         // zoom out
    vec2 za = (uv - 0.5) / (1.0 - e * 0.4) + 0.5;
    vec2 zb = (uv - 0.5) / (2.0 - e) + 0.5;
    o = mix(A(za), B(zb), smoothstep(0.3, 0.7, p)); return;
  }
  if (u_type == 11) { o = mix(texture(u_ab, uv), mix(A(uv), B(uv), smoothstep(0.3, 0.7, p)), abs(p - 0.5) * 2.0); return; } // blur
  if (u_type == 12) {                                                                          // circle reveal
    float r = length((uv - 0.5) * vec2(asp, 1.0));
    float m = smoothstep(e * 1.2 - 0.02, e * 1.2 + 0.02, r);
    o = mix(B(uv), A(uv), m); return;
  }
  if (u_type == 13) {                                                                          // whip pan
    vec4 acc = vec4(0.0);
    float amt = sin(p * 3.14159) * 0.25;
    for (int i = 0; i < 12; i++) {
      float k = float(i) / 11.0 - 0.5;
      vec2 off = vec2(k * amt, 0.0);
      acc += (p < 0.5 ? A(fract(uv + vec2(e, 0.0) + off)) : B(fract(uv + vec2(e - 1.0, 0.0) + off)));
    }
    o = acc / 12.0; return;
  }
  if (u_type == 14) {                                                                          // slide over
    o = A(uv) * (1.0 - step(1.0 - e, uv.x) * 0.0);
    vec4 b = B(uv - vec2(1.0 - e, 0.0));
    o = b + A(uv) * (1.0 - b.a); return;
  }
  if (u_type == 15) {                                                                          // glitch
    float band = floor(uv.y * 24.0);
    float n = fract(sin(band * 91.7 + floor(p * 18.0) * 13.1) * 4375.5);
    float amt = sin(p * 3.14159) * 0.12;
    vec2 g = uv + vec2((n - 0.5) * amt, 0.0);
    vec4 c = p < 0.5 ? A(g) : B(g);
    c.r = (p < 0.5 ? A(g + vec2(amt * 0.3, 0.0)) : B(g + vec2(amt * 0.3, 0.0))).r;
    o = c; return;
  }
  o = mix(A(uv), B(uv), p);
}`;

export const TRANSITION_TYPES = {
  dissolve: { id: 0, name: 'Dissolve' },
  dipBlack: { id: 1, name: 'Dip to black' },
  dipWhite: { id: 2, name: 'Dip to white' },
  pushLeft: { id: 3, name: 'Push left' },
  pushRight: { id: 4, name: 'Push right' },
  pushUp: { id: 5, name: 'Push up' },
  pushDown: { id: 6, name: 'Push down' },
  wipeLeft: { id: 7, name: 'Wipe left' },
  wipeRight: { id: 8, name: 'Wipe right' },
  zoomIn: { id: 9, name: 'Zoom in' },
  zoomOut: { id: 10, name: 'Zoom out' },
  blur: { id: 11, name: 'Blur' },
  circle: { id: 12, name: 'Circle reveal' },
  whip: { id: 13, name: 'Whip pan' },
  slideOver: { id: 14, name: 'Slide over' },
  glitch: { id: 15, name: 'Glitch' },
};

// Blur, pixelate or cover a region of what is already drawn.
export const FS_REGION = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_blurred;
uniform int u_mode;      // 0 blur, 1 pixelate, 2 solid
uniform vec4 u_fill;
uniform vec2 u_res;
uniform vec2 u_center;   // pixels, y down
uniform vec2 u_half;     // pixels
uniform float u_rot;     // radians
uniform int u_shape;     // 0 rect, 1 ellipse
uniform float u_feather; // 0..1
uniform float u_amount;
void main() {
  vec2 px = vec2(v_uv.x, 1.0 - v_uv.y) * u_res;
  vec2 p = px - u_center;
  p = vec2(cos(u_rot) * p.x + sin(u_rot) * p.y, -sin(u_rot) * p.x + cos(u_rot) * p.y);
  vec2 q = p / max(u_half, vec2(1.0));
  float d = u_shape == 1 ? length(q) : max(abs(q.x), abs(q.y));
  float f = max(u_feather, 0.001);
  float m = 1.0 - smoothstep(1.0 - f, 1.0, d);
  vec4 base = texture(u_src, v_uv);
  vec4 eff;
  if (u_mode == 0) eff = texture(u_blurred, v_uv);
  else if (u_mode == 1) {
    float cell = max(4.0, u_amount * 60.0);
    vec2 c = (floor(px / cell) + 0.5) * cell;
    eff = texture(u_src, vec2(c.x, u_res.y - c.y) / u_res);
  } else eff = vec4(u_fill.rgb, 1.0);
  o = mix(base, eff, m);
}`;

// Procedural overlays: dust, sparkles, bokeh, falling flakes, light leaks and
// lens flares. Output is premultiplied, blended like any other layer.
export const FS_PARTICLES = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec2 u_res;        // target size in pixels
uniform float u_scale;     // target px per project px
uniform float u_time;
uniform int u_kind;        // 0 dust, 1 sparkle, 2 bokeh, 3 leak, 4 flare
uniform vec3 u_color;
uniform float u_density, u_size, u_speed, u_seed, u_opacity, u_angle, u_variety;
uniform vec2 u_pos;        // flare position, 0..1 with y down

// sine-free hash (stays random for large cell numbers and seeds)
float h1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + fract(u_seed * 0.6180339) * 7.13);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 h2(vec2 p) { return vec2(h1(p), h1(p + 19.19)); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

vec3 hueShift(vec3 c, float amt) {
  float a = amt * 6.2831;
  vec3 k = vec3(0.57735);
  return c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a));
}

// sum of particles in a moving grid of cells
vec4 field(vec2 px, float cell, float size, int shape) {
  float ang = radians(u_angle);
  vec2 vel = vec2(cos(ang), sin(ang)) * u_speed * 60.0 * u_scale;
  vec2 q = (px - vel * u_time) / cell;
  vec2 c = floor(q);
  float acc = 0.0;
  vec3 col = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cc = c + vec2(float(i), float(j));
    if (h1(cc + 3.7) > u_density) continue;
    vec2 r = h2(cc);
    vec2 wob = vec2(sin(u_time * 0.8 + r.x * 6.2831), cos(u_time * 0.6 + r.y * 6.2831)) * 0.18;
    vec2 p = cc + 0.5 + (r - 0.5) * 0.7 + wob;
    vec2 d = (q - p) * cell;
    float dist = length(d);
    float sz = size * (0.45 + h1(cc + 7.7) * 0.9);
    float tw = 0.5 + 0.5 * sin(u_time * (1.2 + r.x * 3.0) + r.y * 6.2831);
    float v;
    if (shape == 1) {
      float core = exp(-dist * dist / (sz * sz * 0.03));
      float rays = exp(-abs(d.x) / (sz * 0.05)) * exp(-abs(d.y) / (sz * 0.9)) + exp(-abs(d.y) / (sz * 0.05)) * exp(-abs(d.x) / (sz * 0.9));
      v = (core * 1.5 + rays) * pow(tw, 4.0) * 1.6;
    } else if (shape == 2) {
      float disc = smoothstep(sz, sz * 0.9, dist);
      float rim = smoothstep(sz * 0.65, sz * 0.95, dist) * disc;
      v = (disc * 0.28 + rim * 0.22) * (0.6 + 0.4 * tw);
    } else {
      v = exp(-dist * dist / (sz * sz * 0.35)) * (0.35 + 0.65 * tw);
    }
    acc += v;
    col += v * hueShift(u_color, (h1(cc + 11.1) - 0.5) * u_variety * 0.25) * (0.8 + 0.4 * h1(cc + 5.3));
  }
  return vec4(u_variety > 0.0 ? col : u_color * acc, acc);
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 px = uv * u_res;
  float sizePx = u_size * u_scale;
  vec3 rgb = vec3(0.0);
  float a = 0.0;
  if (u_kind <= 2) {
    float cell = sizePx * (u_kind == 2 ? 3.2 : 5.0);
    vec4 f = field(px, cell, sizePx, u_kind);
    if (u_kind == 0) {
      // a second, smaller and slower layer gives depth
      vec4 g = field(px * 1.7 + 311.0, cell, sizePx * 0.7, 0);
      f += g * 0.6;
    }
    rgb = f.rgb;
    a = clamp(f.a, 0.0, 1.0);
  } else if (u_kind == 3) {
    float t = u_time * 0.07 * u_speed;
    float n = fbm(uv * vec2(1.4, 1.0) * (1.2 / max(0.2, u_size / 100.0)) + vec2(t, -t * 0.6) + u_seed);
    float side = smoothstep(0.75, 0.0, abs(uv.x - (0.5 + 0.5 * sin(t * 2.0 + u_seed))) * 1.3);
    float edge = max(smoothstep(0.55, 1.0, uv.x), smoothstep(0.45, 0.0, uv.x));
    float v = smoothstep(0.35, 0.85, n) * mix(edge, side, 0.4) * u_density * 1.6;
    rgb = mix(u_color, u_color * vec3(1.0, 0.75, 0.5) + vec3(0.2, 0.0, 0.0), n) * v;
    a = clamp(v, 0.0, 1.0);
  } else {
    vec2 asp = vec2(u_res.x / u_res.y, 1.0);
    vec2 d = (uv - u_pos) * asp;
    float r = length(d);
    float k = u_size / 100.0;
    float glow = exp(-r * r / (0.004 * k)) + exp(-r / (0.12 * k)) * 0.35;
    float streak = exp(-abs(d.y) / (0.004 * k)) * exp(-abs(d.x) / (0.6 * k)) * 0.8;
    float ghosts = 0.0;
    vec2 axis = (vec2(0.5) - u_pos) * asp;
    for (int i = 1; i <= 4; i++) {
      float f = float(i) * 0.45;
      float gr = length(d - axis * f * 2.0);
      float s = 0.03 + 0.02 * float(i);
      ghosts += smoothstep(s * k, s * k * 0.7, gr) * 0.12;
    }
    float flicker = 0.9 + 0.1 * sin(u_time * 7.0 * u_speed);
    float v = (glow + streak) * flicker * u_density * 1.5 + ghosts * u_density;
    rgb = u_color * v + vec3(glow * 0.35);
    a = clamp(v, 0.0, 1.0);
  }
  rgb = min(rgb, vec3(1.0)) * u_opacity;
  a *= u_opacity;
  o = vec4(min(rgb, vec3(a)), a);
}`;
