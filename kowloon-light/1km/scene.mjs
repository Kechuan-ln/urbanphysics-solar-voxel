// The display mesh casts presentation shadows. Voxel values come from the stored simulation.
const SHADOW_SIZE = 2048;
const HALF_CITY = 850;
const DIRECTIONAL_DEPTH = 1000;

const cameraProjection = `
uniform vec3 uTarget;
uniform vec4 uOrbit;
uniform vec3 uScreen;
vec4 project(vec3 point) {
  vec3 p = point - uTarget;
  float u = p.x * uOrbit.x - p.y * uOrbit.y;
  float v = p.x * uOrbit.y + p.y * uOrbit.x;
  vec2 q = vec2(u, p.z * uOrbit.w - v * uOrbit.z) * uScreen.x;
  return vec4(2.0 * q / uScreen.yz, -(v*uOrbit.w + p.z*uOrbit.z) / 2200.0, 1.0);
}`;

const cut = `
uniform vec3 uCut;
bool clipped(vec3 point) { return dot(point.xy, uCut.xy) > uCut.z; }
`;

const solarProjection = `
uniform vec3 uSolarRight, uSolarUp, uSolarSource;
vec3 sunSpace(vec3 p) {
  p.z -= 50.0;
  return vec3(
    dot(p, uSolarRight) / ${HALF_CITY}.0,
    dot(p, uSolarUp) / ${HALF_CITY}.0,
    -dot(p, uSolarSource) / ${DIRECTIONAL_DEPTH}.0
  );
}`;

const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
  2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3];
const corners = [-.5, -.5, -.5, .5, -.5, -.5, .5, .5, -.5, -.5, .5, -.5,
  -.5, -.5, .5, .5, -.5, .5, .5, .5, .5, -.5, .5, .5];
const cube = new Float32Array(faces.flatMap(i => corners.slice(3 * i, 3 * i + 3)));

export function boxOutline(position, size) {
  const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  return edges.flatMap(i => position.map((v, dim) => v + size * corners[3 * i + dim]));
}

function solarBasis(propagation) {
  const norm = Math.hypot(...propagation);
  const source = propagation.map(x => -x / norm);
  const horizontal = Math.hypot(source[0], source[1]);
  const right = horizontal > 1e-5 ? [-source[1] / horizontal, source[0] / horizontal, 0] : [1, 0, 0];
  const up = [-source[2] * right[1], source[2] * right[0], source[0] * right[1] - source[1] * right[0]];
  return {source, right, up};
}

export function makeRenderer(canvas, createVolumePass) {
  const gl = canvas.getContext("webgl2", {antialias: true, alpha: false});
  if (!gl) throw Error("浏览器需要支持 WebGL 2");

  function shader(kind, source) {
    const s = gl.createShader(kind);
    gl.shaderSource(s, "#version 300 es\nprecision highp float;\nprecision highp int;\n" + source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  }

  function program(vertex, fragment, names = []) {
    const p = gl.createProgram();
    const vs = shader(gl.VERTEX_SHADER, vertex), fs = shader(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
    const uniform = Object.fromEntries(
      [...names, "uTarget", "uOrbit", "uScreen"].map(name => [name, gl.getUniformLocation(p, name)])
    );
    return {p, uniform};
  }

  function upload(buffer, data, usage = gl.STATIC_DRAW) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  }

  function attribute(slot, size, buffer, divisor = 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(slot);
    gl.vertexAttribPointer(slot, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(slot, divisor);
  }

  const sunUniforms = ["uSolarSource", "uSolarUp", "uSolarRight"];
  const depthFromSun = program(`
    layout(location=0) in vec3 point;
    ${solarProjection}
    void main() { gl_Position=vec4(sunSpace(point),1.0); }
  `, "void main() {}", sunUniforms);
  const city = program(`
    layout(location=0) in vec3 point;
    layout(location=1) in vec2 uv;
    out vec3 vPoint;
    out vec2 vUV;
    ${cameraProjection}
    void main() { vPoint=point; vUV=uv; gl_Position=project(point); }
  `, `
    in vec3 vPoint;
    in vec2 vUV;
    uniform sampler2D uPhoto, uShadow;
    uniform float uDaylight;
    out vec4 outColor;
    ${cut}
    ${solarProjection}
    float sunlight(vec3 p, float facing) {
      if (uDaylight == 0.0 || facing <= 0.0) return 0.0;
      vec3 uvw = sunSpace(p)*0.5+0.5;
      if (any(lessThan(uvw,vec3(0.0))) || any(greaterThan(uvw,vec3(1.0)))) return 1.0;
      float bias = mix(0.0011,0.00032,clamp(facing,0.0,1.0));
      float visibility=0.0;
      for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++) {
        float depth=texture(uShadow,uvw.xy+vec2(i,j)/${SHADOW_SIZE}.0).r;
        visibility+=step(uvw.z-bias,depth);
      }
      return visibility/9.0;
    }
    void main() {
      // The camera basis points away from the eye in screen coordinates.
      vec3 normal = normalize(cross(dFdy(vPoint),dFdx(vPoint)));
      if (clipped(vPoint)) discard;
      vec3 base = mix(vec3(0.44,0.49,0.51),texture(uPhoto,vUV).rgb,0.83);
      float facing = max(0.0,dot(normal,uSolarSource));
      float sun = sunlight(vPoint, facing);
      vec3 shade=base*vec3(0.57,0.66,0.82);
      vec3 lit=base*vec3(1.22,1.10,0.89)*(0.83+0.17*sqrt(facing));
      outColor=vec4(mix(shade,lit,sun),1.0);
    }
  `, ["uPhoto", "uShadow", "uDaylight", "uCut", ...sunUniforms]);
  const cityDepth = program(`
    layout(location=0) in vec3 point;
    out vec3 vPoint;
    ${cameraProjection}
    void main() { vPoint=point; gl_Position=project(point); }
  `, `
    in vec3 vPoint;
    out vec4 outColor;
    ${cut}
    void main() { if(clipped(vPoint)) discard; outColor=vec4(0); }
  `, ["uCut"]);
  const voxelVertex = `
    layout(location=0) in vec3 corner;
    layout(location=1) in vec3 point;
    layout(location=2) in vec4 tint;
    ${cameraProjection}
    uniform float uSize;
  `;
  const voxels = program(`
    ${voxelVertex}
    out vec4 vTint;
    void main() { vTint=tint; gl_Position=project(point+corner*uSize); }
  `, `
    in vec4 vTint;
    out vec4 outColor;
    uniform float uOpacity;
    void main(){ outColor=vec4(vTint.rgb,vTint.a*uOpacity); }
  `, ["uSize", "uOpacity"]);
  const pickVoxel = program(`
    ${voxelVertex}
    flat out int vId;
    void main() { vId=gl_InstanceID+1; gl_Position=project(point+corner*uSize); }
  `, `
    flat in int vId;
    out vec4 outColor;
    void main() {
      outColor=vec4(float(vId&255),float((vId>>8)&255),float((vId>>16)&255),255.0)/255.0;
    }
  `, ["uSize"]);
  const haze = program(`
    layout(location=1) in vec3 point;
    layout(location=2) in vec4 tint;
    ${cameraProjection}
    uniform float uPointSize;
    out vec4 vTint;
    void main() {
      vTint=tint;
      gl_Position=project(point);
      gl_PointSize=uPointSize;
    }
  `, `
    in vec4 vTint;
    uniform float uOpacity;
    out vec4 outColor;
    void main() {
      float r=length(2.0*gl_PointCoord-1.0);
      if(r>=1.0) discard;
      float falloff=1.0-smoothstep(0.02,1.0,r);
      outColor=vec4(vTint.rgb,vTint.a*uOpacity*falloff);
    }
  `, ["uPointSize", "uOpacity"]);
  const line = program(`
    layout(location=0) in vec3 point;
    ${cameraProjection}
    void main(){ gl_Position=project(point); }
  `, "uniform vec4 uColor; out vec4 outColor; void main(){ outColor=uColor; }", ["uColor"]);

  const cityVao = gl.createVertexArray(), voxelVao = gl.createVertexArray();
  const fogVao = gl.createVertexArray(), lineVao = gl.createVertexArray();
  const cornerBuffer = gl.createBuffer(), locations = gl.createBuffer(), values = gl.createBuffer();
  const lineBuffer = gl.createBuffer(), photo = gl.createTexture();
  upload(cornerBuffer, cube);
  gl.bindVertexArray(voxelVao);
  attribute(0, 3, cornerBuffer);
  attribute(1, 3, locations, 1);
  attribute(2, 4, values, 1);
  gl.bindVertexArray(fogVao);
  attribute(1, 3, locations);
  attribute(2, 4, values);
  gl.bindVertexArray(lineVao);
  attribute(0, 3, lineBuffer);

  function textureParameters() {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  const shadow = gl.createTexture(), shadowFbo = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, shadow);
  textureParameters();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadow, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  const shadowReady = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const pickFbo = gl.createFramebuffer(), pickColor = gl.createTexture(), pickDepth = gl.createRenderbuffer();
  gl.bindTexture(gl.TEXTURE_2D, pickColor);
  textureParameters();
  let pickWidth = 0, pickHeight = 0;
  let meshIndices = 0, count = 0, size = 5, shadowKey = "";
  const maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];

  function bindCamera(p, state) {
    const {orbit, scale} = state;
    gl.useProgram(p.p);
    gl.uniform3fv(p.uniform.uTarget, orbit.target);
    gl.uniform4f(p.uniform.uOrbit, Math.cos(orbit.yaw), Math.sin(orbit.yaw),
      Math.cos(orbit.pitch), Math.sin(orbit.pitch));
    gl.uniform3f(p.uniform.uScreen, scale, canvas.clientWidth, canvas.clientHeight);
  }

  function setSun(p, basis) {
    gl.uniform3fv(p.uniform.uSolarSource, basis.source);
    gl.uniform3fv(p.uniform.uSolarRight, basis.right);
    gl.uniform3fv(p.uniform.uSolarUp, basis.up);
  }

  function drawMesh() {
    gl.bindVertexArray(cityVao);
    gl.drawElements(gl.TRIANGLES, meshIndices, gl.UNSIGNED_INT, 0);
  }

  function updateShadow(basis, key) {
    if (key === shadowKey) return;
    shadowKey = key;
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(depthFromSun.p);
    setSun(depthFromSun, basis);
    drawMesh();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function sizedCanvas() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (w && h && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
    }
    return {dpr, w, h};
  }

  const volume = createVolumePass?.(gl, program, bindCamera);
  return {
    get supportsShadows() { return shadowReady; },
    setVolumeGrid(meta, ground) { volume.setGrid(meta, ground); },
    setVolumeField(data) { volume.setField(data); },
    pickVolume(x, y, state) {
      return state.volume ? volume.pick(x / canvas.clientWidth, y / canvas.clientHeight, state) : -1;
    },
    setMesh(buffer, image) {
      const head = new DataView(buffer);
      const n = head.getUint32(0, true);
      meshIndices = head.getUint32(4, true);
      const packed = new Int16Array(buffer, 8, n * 3);
      const uv = new Uint16Array(buffer, 8 + n * 6, n * 2);
      const indices = new Uint32Array(meshIndices);
      let index = 0;
      for (let i = 0; i < meshIndices; i++) {
        index += head.getInt32(8 + n * 10 + 4 * i, true);
        indices[i] = index;
      }
      gl.bindVertexArray(cityVao);
      const points = gl.createBuffer(), coords = gl.createBuffer();
      upload(points, Float32Array.from(packed, v => v / 20));
      upload(coords, Float32Array.from(uv, v => v / 65535));
      attribute(0, 3, points);
      attribute(1, 2, coords);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, photo);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      textureParameters();
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      shadowKey = "";
    },
    setLight(positions, colors, displaySize) {
      upload(locations, positions, gl.DYNAMIC_DRAW);
      upload(values, colors, gl.DYNAMIC_DRAW);
      count = positions.length / 3;
      size = displaySize;
    },
    draw(state) {
      const {dpr, w, h} = sizedCanvas();
      if (!w || !h) return;
      const illumination = state.sun || {direction: [0, 0, -1], dni: 0};
      const basis = solarBasis(illumination.direction);
      const sunUp = illumination.dni > 0 && basis.source[2] > 0;
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      if (state.showMesh && meshIndices && sunUp && shadowReady) {
        updateShadow(basis, illumination.direction.join(","));
      }
      if (state.volume) volume.begin(w, h);
      gl.viewport(0, 0, w, h);
      gl.clearColor(.055, .086, .111, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (state.showMesh && meshIndices) {
        bindCamera(city, state);
        setSun(city, basis);
        gl.uniform3fv(city.uniform.uCut, state.cut);
        gl.uniform1f(city.uniform.uDaylight, sunUp && shadowReady ? 1 : 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, shadow);
        gl.uniform1i(city.uniform.uShadow, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, photo);
        gl.uniform1i(city.uniform.uPhoto, 0);
        drawMesh();
      }
      if (state.volume) {
        volume.finish(state, w, h);
        return;
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      if (count && state.showField) {
        const p = state.fog ? haze : voxels;
        bindCamera(p, state);
        gl.uniform1f(p.uniform.uOpacity, state.opacity);
        if (state.fog) {
          gl.uniform1f(p.uniform.uPointSize, Math.min(maxPointSize, Math.max(3, size * state.scale * dpr * 2.5)));
          gl.bindVertexArray(fogVao);
          gl.drawArrays(gl.POINTS, 0, count);
        } else {
          gl.uniform1f(p.uniform.uSize, size);
          gl.bindVertexArray(voxelVao);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
        }
      }
      bindCamera(line, state);
      gl.bindVertexArray(lineVao);
      for (const [points, color] of state.guides) {
        if (!points.length) continue;
        upload(lineBuffer, new Float32Array(points), gl.DYNAMIC_DRAW);
        gl.uniform4fv(line.uniform.uColor, color);
        // Guides keep their edges visible where they cross the cut surface.
        gl.disable(gl.DEPTH_TEST);
        gl.drawArrays(gl.LINES, 0, points.length / 3);
        gl.enable(gl.DEPTH_TEST);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    },
    pick(x, y, state) {
      if (!count || !state.showField) return -1;
      const {dpr, w, h} = sizedCanvas();
      const px = Math.floor(x * dpr), py = h - 1 - Math.floor(y * dpr);
      if (px < 0 || px >= w || py < 0 || py >= h) return -1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
      if (pickWidth !== w || pickHeight !== h) {
        pickWidth = w;
        pickHeight = h;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pickColor);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickColor, 0);
        gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, pickDepth);
      }
      gl.viewport(0, 0, w, h);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(px, py, 1, 1);
      gl.disable(gl.BLEND);
      gl.disable(gl.DITHER);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (state.showMesh && meshIndices) {
        bindCamera(cityDepth, state);
        gl.uniform3fv(cityDepth.uniform.uCut, state.cut);
        drawMesh();
      }
      bindCamera(pickVoxel, state);
      gl.uniform1f(pickVoxel.uniform.uSize, size);
      gl.bindVertexArray(voxelVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
      const rgba = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.enable(gl.DITHER);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return rgba[0] + 256 * rgba[1] + 65536 * rgba[2] - 1;
    },
  };
}
