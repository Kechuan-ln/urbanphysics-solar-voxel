import {binary} from "./sections.mjs?v=2";

const metrics = ["direct", "scatter", "reflection"];
const screenTriangle = `
out vec2 vUV;
void main() {
  vUV = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(vUV * 2.0 - 1.0, 0.0, 1.0);
}`;

// Camera coordinates are the inverse of the orthographic photomesh projection.
const march = `
in vec2 vUV;
out vec4 outColor;
uniform vec3 uTarget;
uniform vec4 uOrbit;
uniform vec3 uScreen;
uniform sampler2D uDepth, uGround;
uniform highp usampler3D uField;
uniform ivec3 uGrid;
uniform vec2 uBoundsZ;
uniform float uOrigin, uCell, uTop, uOpacity, uToneSteps;
uniform int uComponent;
uniform bool uShowUnknown, uPick;

float reciprocal(float x) { return abs(x) > 1e-6 ? 1.0 / x : 1e6; }

void main() {
  vec2 q = (vUV - 0.5) * uScreen.yz / uScreen.x;
  vec3 horizontal = vec3(uOrbit.y, uOrbit.x, 0.0);
  vec3 right = vec3(uOrbit.x, -uOrbit.y, 0.0);
  vec3 towardCamera = horizontal * uOrbit.w + vec3(0.0, 0.0, uOrbit.z);
  vec3 up = -horizontal * uOrbit.z + vec3(0.0, 0.0, uOrbit.w);
  vec3 from = uTarget + q.x * right + q.y * up + 2200.0 * towardCamera;
  vec3 along = -towardCamera;
  vec3 inv = vec3(reciprocal(along.x), reciprocal(along.y), reciprocal(along.z));
  vec3 first = (vec3(uOrigin, uOrigin, uBoundsZ.x) - from) * inv;
  vec3 last = (vec3(uOrigin + uCell * vec2(uGrid.xy), uBoundsZ.y) - from) * inv;
  vec3 nearBox = min(first, last), farBox = max(first, last);
  float near = max(0.0, max(max(nearBox.x, nearBox.y), nearBox.z));
  float far = min(min(farBox.x, farBox.y), farBox.z);
  far = min(far, texture(uDepth, vUV).r * 4400.0);
  float jitter = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
  float distance = near + mix(0.20, 0.80, jitter) * uCell;
  vec3 accumulated = vec3(0.0);
  float transmission = 1.0, bestWeight = 0.0;
  int best = 0;

  for (int i = 0; i < 320; i++, distance += uCell) {
    if (distance >= far || transmission < 0.035) break;
    vec3 point = from + along * distance;
    ivec2 xy = ivec2(floor((point.xy - uOrigin) / uCell));
    if (any(lessThan(xy, ivec2(0))) || any(greaterThanEqual(xy, uGrid.xy))) continue;
    float agl = point.z - texelFetch(uGround, xy, 0).r;
    if (agl < 0.0 || agl >= uTop) continue;
    int level = int(agl / uCell);
    if (level >= uGrid.z) continue;
    int code = int(texelFetch(uField, ivec3(level, xy), 0).r);
    if (code == 0 || (code == 1 && !uShowUnknown)) continue;

    vec3 tint;
    float density;
    if (code == 1) {
      tint = vec3(0.47, 0.54, 0.59);
      density = 0.0004;
    } else if (uComponent == 0) {
      bool lit = code > 2;
      tint = lit ? vec3(1.0, 0.77, 0.40) : vec3(0.17, 0.37, 0.68);
      density = lit ? 0.00095 : 0.0064 + 0.0090 * exp(-agl / 32.0);
    } else {
      float strength = clamp(float(code - 2) / uToneSteps, 0.0, 1.0);
      tint = uComponent == 1
        ? mix(vec3(0.18, 0.47, 0.71), vec3(0.55, 0.92, 1.0), strength)
        : mix(vec3(0.43, 0.29, 0.63), vec3(0.98, 0.70, 0.85), strength);
      density = strength * (0.0032 + 0.008 * strength * strength);
      if (uComponent == 1) density *= 0.58;
      vec2 within = point.xy - uOrigin;
      vec2 border = min(within, uCell * vec2(uGrid.xy) - within);
      density *= smoothstep(0.0, 2.0 * uCell, min(border.x, border.y));
    }
    density *= 1.0 - smoothstep(uTop - 4.0, uTop, agl);
    float alpha = 1.0 - exp(-density * uCell * uOpacity);
    float weight = transmission * alpha;
    if (uPick && weight > bestWeight) {
      bestWeight = weight;
      best = (xy.y * uGrid.x + xy.x) * uGrid.z + level + 1;
    }
    accumulated += weight * tint;
    transmission *= 1.0 - alpha;
  }
  outColor = uPick
    ? vec4(float(best & 255), float((best >> 8) & 255), float((best >> 16) & 255), 255.0) / 255.0
    : vec4(accumulated, 1.0 - transmission);
}`;

export async function openVolume(path, demo, voxelCount) {
  const url = new URL(path, document.baseURI);
  const reply = await fetch(url);
  if (!reply.ok) throw Error(`全区体渲染清单读取失败（${reply.status}）`);
  const meta = await reply.json();
  if (meta.format !== "kowloon-render-volume-v1" || meta.layout !== "column-level" ||
      meta.sourceCommit !== demo.sourceCommit || meta.voxels !== voxelCount ||
      meta.size !== 200 || meta.levels !== 24 || meta.origin !== -500 || meta.step !== 5 ||
      meta.hours.length !== demo.hours.length || meta.hours.some((hour, i) => hour !== demo.hours[i])) {
    throw Error("体渲染与原始 5 米剖切索引不一致");
  }
  const ground = new Float32Array(await binary(new URL("ground.bin.gz", url)));
  if (ground.length !== meta.size ** 2) throw Error("地面高程格网长度不一致");
  const cache = new Map();
  return {
    meta, ground,
    async read(hour, metric, bin, signal) {
      const direction = bin >= 0 ? bin : "mean";
      const asset = metric === "direct" ? `direct-${hour}.bin.gz` : `${metric}-${hour}-${direction}.bin.gz`;
      const previous = cache.get(asset);
      if (previous) return previous;
      const data = new Uint8Array(await binary(new URL(asset, url), signal));
      if (data.length !== meta.size ** 2 * meta.levels) throw Error("体渲染光场格网长度不一致");
      cache.set(asset, data);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
      return data;
    },
    cell(id) {
      const col = Math.floor(id / meta.levels);
      const index = id % meta.levels;
      const x = col % meta.size, y = Math.floor(col / meta.size);
      const h = (index + 0.5) * meta.step;
      return {y, point: [meta.origin + (x + 0.5) * meta.step, meta.origin + (y + 0.5) * meta.step,
        ground[col] + h, h]};
    },
  };
}

export function makeVolumePass(gl, program, bindCamera) {
  const fog = program(screenTriangle, march, ["uDepth", "uGround", "uField", "uGrid", "uBoundsZ",
    "uOrigin", "uCell", "uTop", "uOpacity", "uToneSteps", "uComponent", "uShowUnknown", "uPick"]);
  const merge = program(screenTriangle, `
    in vec2 vUV;
    out vec4 outColor;
    uniform sampler2D uCity, uFog;
    void main() {
      vec4 air = texture(uFog, vUV);
      outColor = vec4(air.rgb + (1.0 - air.a) * texture(uCity, vUV).rgb, 1.0);
    }`, ["uCity", "uFog"]);
  const screen = gl.createVertexArray();
  const groundTexture = gl.createTexture(), fieldTexture = gl.createTexture();
  const scene = {fbo: gl.createFramebuffer(), color: gl.createTexture(), depth: gl.createTexture()};
  const air = {fbo: gl.createFramebuffer(), color: gl.createTexture()};
  let grid;

  function configureTexture(target, filter = gl.NEAREST) {
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function framebuffer(surface, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, surface.fbo);
    if (surface.w === w && surface.h === h) return;
    surface.w = w;
    surface.h = h;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, surface.color);
    configureTexture(gl.TEXTURE_2D, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, surface.color, 0);
    if (surface.depth) {
      gl.bindTexture(gl.TEXTURE_2D, surface.depth);
      configureTexture(gl.TEXTURE_2D);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, surface.depth, 0);
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw Error("体渲染缓冲区无法初始化");
    }
  }

  function texture(p, name, unit, kind, content) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(kind, content);
    gl.uniform1i(p.uniform[name], unit);
  }

  function drawFog(state, picking) {
    bindCamera(fog, state);
    const u = fog.uniform;
    texture(fog, "uDepth", 0, gl.TEXTURE_2D, scene.depth);
    texture(fog, "uGround", 1, gl.TEXTURE_2D, groundTexture);
    texture(fog, "uField", 2, gl.TEXTURE_3D, fieldTexture);
    gl.uniform3i(u.uGrid, grid.size, grid.size, grid.levels);
    gl.uniform2fv(u.uBoundsZ, grid.boundsZ);
    gl.uniform1f(u.uOrigin, grid.origin);
    gl.uniform1f(u.uCell, grid.step);
    gl.uniform1f(u.uTop, state.volume.height);
    gl.uniform1f(u.uOpacity, state.opacity);
    gl.uniform1f(u.uToneSteps, grid.toneSteps);
    gl.uniform1i(u.uShowUnknown, state.volume.showUnknown ? 1 : 0);
    gl.uniform1i(u.uComponent, metrics.indexOf(state.volume.metric));
    gl.uniform1i(u.uPick, picking ? 1 : 0);
    gl.bindVertexArray(screen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    setGrid(meta, ground) {
      grid = meta;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, groundTexture);
      configureTexture(gl.TEXTURE_2D);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, meta.size, meta.size, 0, gl.RED, gl.FLOAT, ground);
      gl.bindTexture(gl.TEXTURE_3D, fieldTexture);
      configureTexture(gl.TEXTURE_3D);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8UI, meta.levels, meta.size, meta.size);
    },
    setField(data) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, fieldTexture);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, grid.levels, grid.size, grid.size,
        gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
    },
    begin(w, h) {
      framebuffer(scene, w, h);
    },
    finish(state, w, h) {
      const ratio = state.volume.interacting ? Math.min(0.4, 440 / w) : Math.min(0.67, 720 / w);
      framebuffer(air, Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio)));
      gl.viewport(0, 0, air.w, air.h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      drawFog(state, false);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(merge.p);
      texture(merge, "uCity", 0, gl.TEXTURE_2D, scene.color);
      texture(merge, "uFog", 1, gl.TEXTURE_2D, air.color);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    pick(x, y, state) {
      if (!air.w || x < 0 || x >= 1 || y < 0 || y >= 1) return -1;
      const px = Math.floor(x * air.w), py = air.h - 1 - Math.floor(y * air.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, air.fbo);
      gl.viewport(0, 0, air.w, air.h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.DITHER);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(px, py, 1, 1);
      drawFog(state, true);
      const color = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, color);
      gl.disable(gl.SCISSOR_TEST);
      gl.enable(gl.DITHER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return color[0] + 256 * color[1] + 65536 * color[2] - 1;
    },
  };
}
