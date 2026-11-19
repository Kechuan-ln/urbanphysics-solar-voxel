import {boxOutline, makeRenderer} from "./scene.mjs?v=volume-v1";

const $ = (id) => document.getElementById(id);
const canvas = $("scene");
const labels = {direct: "太阳直射", scatter: "天空散射", reflection: "环境反射"};
const enu = {north: [0, 1, 0], east: [1, 0, 0], south: [0, -1, 0],
  west: [-1, 0, 0], up: [0, 0, 1], down: [0, 0, -1]};
const fogScales = {
  scatter: {cap: 60, ramp: [[33, 69, 106], [73, 162, 201], [167, 243, 255]]},
  reflection: {cap: 30, ramp: [[69, 48, 101], [168, 115, 189], [255, 199, 214]]},
};
const dayTint = [1, .73, .38], shadowTint = [.29, .47, .65], unknownTint = [.60, .65, .68];
const fieldUnit = "W/(m²·sr)";
const orbit = {yaw: .57, pitch: .98, zoom: 1, target: [0, 0, 52]};
const layouts = new Map();
const frames = new Map();
let meta, demo, sections, renderer, solarTrack, snapshot, samples, drag, cutDrag, pickedCell;
let volumes, volumeFrame, pendingPick;
let directVolumeAway = false;
let area = "overview", selectedTile = "5-5", cutMode = false;
let metric = "direct", lensMetric = "scatter", exactBin = null;
let stageHour, displayBin = -1, rAF = 0, request = 0, controller, timeDelay;

function pixelsPerMeter() {
  return Math.min(canvas.clientWidth / 1430, canvas.clientHeight / 1150) * orbit.zoom;
}

function projectVector([east, north, up]) {
  const u = Math.cos(orbit.yaw) * east - Math.sin(orbit.yaw) * north;
  const v = Math.sin(orbit.yaw) * east + Math.cos(orbit.yaw) * north;
  return [u, v * Math.cos(orbit.pitch) - up * Math.sin(orbit.pitch)];
}

function screenPoint(position) {
  const p = projectVector(position.map((v, dim) => v - orbit.target[dim]));
  const s = pixelsPerMeter();
  return [canvas.clientWidth / 2 + s * p[0], canvas.clientHeight / 2 + s * p[1]];
}

function sunAt(hour) {
  if (demo) return demo.sun[hour];
  if (solarTrack) {
    const [east, north, up, dni] = solarTrack.subarray(4 * hour, 4 * hour + 4);
    return {direction: [east, north, up], dni};
  }
  return snapshot?.hour === hour ? snapshot.sun : null;
}

function tileOrigin() {
  return area.split("-").map(index => 100 * Number(index) - 500);
}

function section() {
  if (!cutMode) return null;
  const axis = Number($("cut-axis").value), index = Number($("cut-position").value);
  const origin = sections ? null : tileOrigin();
  const position = sections ? sections.position(index) : origin[axis] + 2.5 + index * 5;
  const start = sections ? sections.origin : origin[1 - axis];
  const side = (axis === 0 ? Math.sin(orbit.yaw) : Math.cos(orbit.yaw)) >= 0 ? 1 : -1;
  const normal = axis === 0 ? [side, 0] : [0, side];
  return {axis, index, position, start, span: sections?.span ?? 100, clip: [...normal, side * position]};
}

function sectionPoint(slice, along, up) {
  return slice.axis === 0 ? [slice.position, along, up] : [along, slice.position, up];
}

function volumeKey() {
  return `${stageHour}:${metric}:${metric === "direct" ? -1 : displayBin}`;
}

function volumeVisible() {
  return area === "volume" && volumeFrame === volumeKey() && $("show-field").checked && !directVolumeAway;
}

function glState() {
  const slice = section();
  const guides = [];
  if (slice) {
    const minZ = samples?.minZ ?? 8, maxZ = samples?.maxZ ?? 145;
    const a = sectionPoint(slice, slice.start, minZ - 2.5);
    const b = sectionPoint(slice, slice.start + slice.span, minZ - 2.5);
    const c = sectionPoint(slice, slice.start + slice.span, maxZ + 2.5);
    const d = sectionPoint(slice, slice.start, maxZ + 2.5);
    guides.push([[...a, ...b, ...b, ...c, ...c, ...d, ...d, ...a], [.51, .89, .85, .74]]);
  }
  if (pickedCell && samples?.selection) {
    guides.push([boxOutline(samples.selection.position, area === "overview" ? 13.4 : 5.25), [1, .90, .62, 1]]);
  }
  return {
    orbit, scale: pixelsPerMeter(), guides, sun: sunAt(stageHour), cut: slice?.clip ?? [0, 0, 0],
    showMesh: $("show-mesh").checked, showField: Boolean(samples && $("show-field").checked),
    fog: metric !== "direct", opacity: Number($("opacity").value) / 100,
    volume: volumeVisible() ? {
      metric, height: Number($("volume-top").value), showUnknown: $("show-unknown").checked,
      interacting: Boolean(drag?.d > 3),
    } : null,
  };
}

function placeHandle() {
  const slice = section(), handle = $("cut-handle");
  handle.hidden = !slice;
  if (!slice) return;
  const [x, y] = screenPoint(sectionPoint(slice, slice.start + slice.span / 2, (samples?.maxZ ?? 145) + 3));
  handle.style.left = `${Math.max(52, Math.min(canvas.clientWidth - 52, x))}px`;
  // Keep the handle clear of the time and compass overlays while zooming in.
  handle.style.top = `${Math.max(116, Math.min(canvas.clientHeight - 28, y))}px`;
}

function compass() {
  const c = $("arrows").getContext("2d");
  c.clearRect(0, 0, 228, 148);
  const arrow = (vector, color, x, y, lineWidth, length) => {
    const p = projectVector(vector);
    const dx = p[0] * length, dy = p[1] * length;
    if (Math.hypot(dx, dy) < 1) return;
    const a = Math.atan2(dy, dx);
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = lineWidth;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + dx, y + dy);
    c.stroke();
    c.beginPath();
    c.moveTo(x + dx, y + dy);
    for (const d of [-.5, .5]) {
      c.lineTo(x + dx - 12*Math.cos(a+d), y + dy - 12*Math.sin(a+d));
    }
    c.fill();
  };
  arrow(enu.north, "#8f9fab", 31, 75, 3, 45);
  c.font = "19px system-ui";
  c.fillStyle = "#a7b8c3";
  c.fillText("N", 20, 101);
  const sun = sunAt(stageHour);
  if (!sun) return;
  const [az, alt] = angles(sun.direction);
  $("sun-info").textContent = alt < 0 ?
    `太阳光 ${az.toFixed(0)}° / ${alt.toFixed(0)}°` : "太阳低于地平线";
  if (alt < 0) arrow(sun.direction, "#f7ce83", 111, 62, 5, 57);
  $("query-arrow").hidden = displayBin < 0 || (metric === "direct" && $("direction").value === "sun");
  if (displayBin >= 0 && !(metric === "direct" && $("direction").value === "sun")) {
    arrow(meta.propagation_enu[displayBin], "#87e5d7", 181, 62, 4, 48);
  }
}

function draw() {
  if (rAF) return;
  rAF = requestAnimationFrame(() => {
    rAF = 0;
    renderer.draw(glState());
    compass();
    placeHandle();
  });
}

function timeLabel(hour) {
  const ms = Date.parse(meta.first) + hour * 3600000;
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 16);
}

function chooseTime(hour) {
  const local = timeLabel(hour);
  $("date").value = local.slice(0, 10);
  $("time-hour").value = local.slice(11, 13);
  return stageTime(hour);
}

function chosenHour() {
  const ms = Date.parse(`${$("date").value}T${$("time-hour").value}:00:00+08:00`);
  return (ms - Date.parse(meta.first)) / 3600000;
}

function stageTime(hour) {
  const step = demo?.hours.indexOf(hour);
  if (!Number.isInteger(hour) || hour < 0 || hour >= meta.hours || step === -1) {
    $("status").textContent = demo ? "请选择一个演示时刻" : "请选择模拟年份内的整点";
    return false;
  }
  const date = timeLabel(hour);
  $("timeline").value = step ?? Number(date.slice(11, 13));
  if (demo) {
    $("prev").disabled = step === 0;
    $("next").disabled = step === demo.hours.length - 1;
  }
  $("timeline-label").textContent = date.slice(11);
  $("timeline").setAttribute("aria-valuetext", date.slice(11));
  $("stamp").textContent = date.replace("T", " ") + " HKT";
  if (stageHour !== hour) {
    stageHour = hour;
    request++;
    controller?.abort();
    $("progress").hidden = true;
    $("retry").hidden = true;
    $("status").textContent = "正在切换时刻";
    updateField();
  }
  return true;
}

function decode(buffer, n) {
  const head = new DataView(buffer);
  const bins = meta.propagation_enu.length;
  if (head.getUint32(0, true) !== n || head.getUint32(4, true) !== bins) {
    throw Error("光场数据与体素索引不一致");
  }
  let offset = 8;
  const read = (Type, count) => {
    const x = new Type(buffer, offset, count);
    offset += x.byteLength;
    return x;
  };
  const data = {
    scatter: read(Float32Array, n*bins),
    reflection: read(Float32Array, n*bins),
    direct: read(Float64Array, n),
  };
  const flags = {
    scatter: read(Uint8Array, n*bins),
    reflection: read(Uint8Array, n*bins),
    direct: read(Uint8Array, n),
  };
  if (offset !== buffer.byteLength) throw Error("光场数据长度不一致");
  return {data, flags};
}

async function get(url, signal) {
  const isDemoAsset = demo && url.startsWith("./api/");
  const path = isDemoAsset ? demo.files[url.slice(1)] : url;
  if (!path) throw Error("此范围未包含在演示中");
  const response = await fetch(path, {signal});
  if (!response.ok) {
    const diagnostic = await response.json().catch(() => ({}));
    throw Error(diagnostic.error || `请求失败（${response.status}）`);
  }
  if (!isDemoAsset) return response;
  const buffer = await response.arrayBuffer();
  const header = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
  if (header[0] !== 31 || header[1] !== 139 || header[2] !== 8) return new Response(buffer);
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream);
}

function fieldScope() {
  if (sections && cutMode) {
    const {axis, index} = section();
    return `section=${axis}&index=${index}`;
  }
  return `area=${area}&height=${cutMode ? "all" : $("height").value}`;
}

function activeSnapshot() {
  if (snapshot?.hour !== stageHour || snapshot?.scope !== fieldScope()) return null;
  return metric === "reflection" && snapshot.reflectionLoaded === false ? null : snapshot;
}

function wantsReflection() {
  return metric === "reflection" || Boolean(pickedCell && lensMetric === "reflection");
}

function showSnapshot(frame) {
  snapshot = frame;
  if (cutMode && pendingPick) {
    const [east, north, , agl] = pendingPick;
    const points = frame.points;
    for (let p = 0; p < points.length; p += 4) {
      if (points[p] === east && points[p + 1] === north && points[p + 3] === agl) {
        pickedCell = {points, index: p / 4};
        break;
      }
    }
    pendingPick = null;
  }
  $("progress").hidden = true;
  $("status").textContent = cutMode ? `${sections ? "全区" : "街谷"}剖切 · 原始 5 米体素` :
    area === "overview" ? "全区 · 水平 25 米抽样" : "局部 · 原始 5 米体素";
  updateField();
}

function cacheFrame(key, frame) {
  frames.delete(key);
  frames.set(key, frame);
  if (frames.size > 5) frames.delete(frames.keys().next().value);
  showSnapshot(frame);
}

async function load() {
  clearTimeout(timeDelay);
  $("retry").hidden = true;
  const hour = chosenHour();
  if (!stageTime(hour)) return;
  const id = ++request;
  controller?.abort();
  controller = new AbortController();
  const {signal} = controller;
  const scope = fieldScope();
  const key = `${scope}&hour=${hour}`;
  if (!$("show-field").checked) {
    updateField();
    $("status").textContent = cutMode ? "剖切 · 实景阴影" : "实景阴影 · 随太阳位置更新";
    $("progress").hidden = true;
    return;
  }
  const cached = frames.get(key);
  const needReflection = wantsReflection();
  if (cached && (!needReflection || cached.reflectionLoaded !== false)) {
    cacheFrame(key, cached);
    return;
  }
  updateField();
  const date = timeLabel(hour).replace("T", " ");
  $("status").textContent = "正在读取光场";
  $("progress").hidden = false;
  $("progress").removeAttribute("value");
  try {
    if (area === "volume") {
      if (directVolumeAway) {
        $("status").textContent = "当前方向无太阳直射";
        $("progress").hidden = true;
        return;
      }
      const target = volumeKey();
      if (target !== volumeFrame) {
        const bytes = await volumes.read(hour, metric, displayBin, signal);
        if (id !== request) return;
        renderer.setVolumeField(bytes);
        volumeFrame = target;
      }
      $("progress").hidden = true;
      $("status").textContent = "全区体渲染 · 原始 5 米网格";
      updateField();
      return;
    }
    if (sections && cutMode) {
      const {axis, index} = section();
      const field = await sections.read(axis, index, hour, needReflection, signal);
      if (id !== request) return;
      if (!layouts.has(scope)) layouts.set(scope, field.points);
      cacheFrame(key, {...field, points: layouts.get(scope), hour, scope, sun: sunAt(hour)});
      return;
    }
    if (!layouts.has(scope)) {
      const response = await get(`./api/coords?${scope}`, signal);
      layouts.set(scope, new Float32Array(await response.arrayBuffer()));
    }
    const points = layouts.get(scope);
    const url = `./api/frame?${key}`;
    let response = await get(url, signal);
    while (response.status === 202) {
      const progress = await response.json();
      if (id !== request) return;
      $("progress").value = progress.progress;
      $("status").textContent = `正在读取 ${date} · ${Math.round(100*progress.progress)}%`;
      await new Promise((resolve) => setTimeout(resolve, 1300));
      if (signal.aborted) return;
      response = await get(url, signal);
    }
    const sun = demo ? sunAt(hour) : {
      direction: response.headers.get("X-Sun-ENU").split(",").map(Number),
      dni: Number(response.headers.get("X-Sun-DNI")),
    };
    const field = decode(await response.arrayBuffer(), points.length / 4);
    if (id !== request) return;
    cacheFrame(key, {points, hour, sun, scope, ...field});
  } catch (error) {
    if (id !== request || error.name === "AbortError") return;
    $("progress").hidden = true;
    $("status").textContent = error.message;
    $("retry").hidden = false;
  }
}

const radians = Math.PI / 180;
function vector(az, alt) {
  const a = az*radians, b = alt*radians;
  return [Math.cos(b)*Math.sin(a), Math.cos(b)*Math.cos(a), Math.sin(b)];
}

function angles(p) {
  return [(Math.atan2(p[0], p[1]) / radians + 360) % 360, Math.asin(Math.max(-1, Math.min(1, p[2]))) / radians];
}

function nearest(query) {
  let index = 0, best = -Infinity;
  for (let i = 0; i < meta.propagation_enu.length; i++) {
    const p = meta.propagation_enu[i];
    const dot = p[0]*query[0] + p[1]*query[1] + p[2]*query[2];
    if (dot > best) { index = i; best = dot; }
  }
  return {index, error: Math.acos(Math.max(-1, Math.min(1, best))) / radians};
}

function strength(value, cap) {
  return Math.sqrt(Math.max(0, Math.min(1, value / cap)));
}

function shade(value, {cap, ramp}) {
  const t = 2 * strength(value, cap);
  const lo = Math.min(1, Math.floor(t));
  return ramp[lo].map((v, i) => (v + (ramp[lo+1][i] - v) * (t - lo)) / 255);
}

function directionState(sun) {
  const mode = $("direction").value;
  const q = mode === "sun" ? sun?.direction : enu[mode] ||
    vector(Number($("az").value), Number($("alt").value));
  const selected = mode === "mean" || !q ? null : exactBin === null ? nearest(q) : {index: exactBin, error: 0};
  displayBin = selected?.index ?? -1;
  const direct = metric === "direct";
  const directAway = direct && mode !== "sun" && sun && displayBin !== nearest(sun.direction).index;
  if (direct && mode === "sun" && sun) {
    $("direction-note").textContent = `太阳光传播 ${angleLabel(sun.direction)}`;
  } else if (selected) {
    $("direction-note").textContent = `方向 ${displayBin + 1}/128 · ${angleLabel(meta.propagation_enu[displayBin])}` +
      (selected.error >= .05 ? ` · 偏差 ${selected.error.toFixed(1)}°` : "");
  } else {
    $("direction-note").textContent = mode === "mean" ? "等权平均已知方向。" : "等待太阳方向";
  }
  if (directAway) $("direction-note").textContent += "。此方向直射为 0。";
  return {direct, directAway};
}

function setLegend(direct, fog, shown = $("show-field").checked && Boolean(samples)) {
  const unit = direct ? (area === "volume" ? "光照与遮挡" : "W/m²") : fieldUnit;
  $("legend-title").textContent = shown ? `${labels[metric]} · ${unit}` : "实景阴影";
  $("shadow-key").hidden = shown && !direct;
  $("field-key").hidden = !shown || direct;
  if (fog) {
    const colors = fog.ramp.map(rgb => `rgb(${rgb.join(",")})`);
    $("field-ramp").style.background = `linear-gradient(90deg, ${colors.join(",")})`;
    $("max-value").textContent = `≥${fog.cap} ${fieldUnit}`;
  }
}

function updateField() {
  const sun = sunAt(stageHour);
  if ($("direction").value === "sun" && sun) setAngles(sun.direction);
  $("az-value").textContent = $("az").value + "°";
  $("alt-value").textContent = $("alt").value + "°";
  const {direct, directAway} = directionState(sun);
  const fog = fogScales[metric];
  $("metric-note").textContent = direct ? "直射法向辐照度" :
    metric === "scatter" ? "天空散射的方向辐亮度" : "建筑、地面和远场反射的方向辐亮度";
  if (area === "volume") {
    directVolumeAway = directAway;
    samples = null;
    $("point").hidden = true;
    const shown = volumeVisible();
    $("coverage").textContent = shown ?
      `距地 0–${$("volume-top").value} m · 点击光场查询原始体素` : "阴影由实景网格投影";
    setLegend(direct, fog, shown);
    draw();
    return;
  }
  const frame = activeSnapshot(), slice = section();
  samples = null;
  if (slice) {
    const axisLabel = slice.axis === 0 ? "东" : "北";
    $("cut-value").textContent = `${axisLabel} ${slice.position} m · ${slice.index + 1}/${sections?.size ?? 20}`;
    $("cut-position").setAttribute("aria-valuetext", $("cut-value").textContent);
  }
  if (!frame || !$("show-field").checked) {
    $("point").hidden = true;
    $("coverage").textContent = $("show-mesh").checked ? "阴影由实景展示网格实时投影" : "";
    setLegend(direct, fog);
    draw();
    return;
  }
  const {points, data, flags} = frame;
  const height = $("height").value;
  const positions = [], colors = [];
  const visible = [];
  const bins = meta.propagation_enu.length;
  let unknown = 0, approx = 0, known = 0, selection;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length/4; i++) {
    const p = i*4;
    if (slice && Math.abs(points[p + slice.axis] - slice.position) > .01) continue;
    if (!slice && height !== "all" && Math.abs(points[p + 3] - Number(height)) > .01) continue;
    const z = points[p+2];
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    let value = 0, flag = 0, n = bins;
    if (direct) {
      value = directAway ? 0 : data.direct[i];
      flag = directAway ? 1 : flags.direct[i];
    } else if (displayBin >= 0) {
      value = data[metric][i*bins+displayBin];
      flag = flags[metric][i*bins+displayBin];
    } else {
      n = 0;
      for (let j = 0; j < bins; j++) {
        const k = i*bins+j;
        if (!flags[metric][k]) continue;
        n++;
        value += data[metric][k];
        flag = Math.max(flag, flags[metric][k]);
      }
      value = n ? value/n : 0;
    }
    if (flag) { known++; if (flag === 2) approx++; } else unknown++;
    if (!flag && !$("show-unknown").checked) continue;
    const rgb = !flag ? unknownTint : direct ? (value > 0 ? dayTint : shadowTint) : shade(value, fog);
    const alpha = !flag ? .28 : direct ? (value > 0 ? .75 : .48) :
      (value > 0 ? .12 + .68 * strength(value, fog.cap) : .026);
    const position = Array.from(points.subarray(p, p + 3));
    positions.push(...position);
    colors.push(...rgb, alpha);
    const item = {i, position, value, flag, n};
    if (pickedCell?.points === points && pickedCell.index === i) selection = item;
    visible.push(item);
  }
  samples = {visible, selection, unit: direct ? "W/m²" : fieldUnit,
    minZ: Number.isFinite(minZ) ? minZ : undefined, maxZ: Number.isFinite(maxZ) ? maxZ : undefined};
  const count = (v) => v.toLocaleString("zh-CN");
  $("coverage").textContent = `${count(known)} 个已知 · ${count(unknown)} 个未知 · ${count(approx)} 个含远场近似` +
    (direct ? " · 灰色为未知" : "");
  renderer.setLight(new Float32Array(positions), new Float32Array(colors), area === "overview" ? 13 : 5);
  setLegend(direct, fog);
  drawLens();
  draw();
}

function resetView() {
  const slice = section();
  const overview = area === "overview" || area === "volume";
  orbit.yaw = slice ? (slice.axis === 0 ? 1.42 : .17) : .57;
  orbit.pitch = slice ? 1.04 : .98;
  orbit.zoom = slice ? (sections ? 1.33 : 6) : overview ? 1 : 4.6;
  const [east, north] = overview || area === "full" ? [-50, -50] : tileOrigin();
  orbit.target = [east + 50, north + 50, slice ? 77 : area === "overview" ? 52 : 65];
  draw();
}

function viewControls() {
  $("overview").setAttribute("aria-pressed", String(area === "overview" || area === "volume"));
  $("section-mode").setAttribute("aria-pressed", String(cutMode));
  $("cut-controls").hidden = !cutMode;
  $("height-controls").hidden = cutMode || area === "volume";
  if (volumes) $("volume-controls").hidden = area !== "volume";
  $("help").textContent = area === "volume" ?
    "拖动旋转 · Shift 平移 · 滚轮缩放 · 点击光场打开体素剖面" :
    "拖动旋转 · Shift 平移 · 滚轮缩放 · 点击体素查看方向";
}

function changeArea(next, useCut, target = null) {
  if (area === next && cutMode === useCut) return;
  area = next;
  cutMode = useCut;
  pickedCell = null;
  pendingPick = target;
  if (next !== "overview") {
    if (next !== "full" && next !== "volume") selectedTile = next;
    $("show-field").checked = true;
  }
  for (const btn of document.querySelectorAll("#tiles button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.tile === next));
  }
  viewControls();
  updateScopeNote();
  resetView();
  load();
}

function updateScopeNote() {
  if (area === "volume") {
    $("scope-note").textContent = "1 km² · 5 米三维网格";
  } else if (area === "overview") {
    $("scope-note").textContent = demo ? `1 km² 实景 · 距地 ${demo.overviewHeight} 米光场 · 水平 25 米抽样` :
      "整个 1 km² · 水平 25 米抽样 · 垂直 5 米";
  } else if (area === "full") {
    $("scope-note").textContent = `剖切贯穿 1 km² · 每轴 ${sections.size} 个切面 · 原始 5 米体素`;
  } else {
    $("scope-note").textContent = `图块 ${Number(area[0])+1}, ${Number(area[2])+1} · 100 × 100 米 · 原始 5 米体素`;
  }
}

function angleLabel(direction) {
  const [az, alt] = angles(direction);
  return `${az.toFixed(1)}° / ${alt.toFixed(1)}°`;
}

const lens = $("direction-lens");
const disc = {y: 151, radius: 105};
let lensDots = [];

function lensPosition(direction) {
  const [az] = angles(direction);
  const r = disc.radius * Math.sqrt(Math.max(0, 1 - Math.abs(direction[2])));
  return [(direction[2] > 0 ? 480 : 160) + r * Math.sin(az * radians), disc.y - r * Math.cos(az * radians)];
}

function describeValue(value, flag, unit) {
  if (!flag) return "未知";
  return `${value.toFixed(2)} ${unit}` + (flag === 2 ? " · 含远场近似" : "");
}

function describeBin(dot) {
  $("lens-selection").textContent = dot ?
    `方向 ${dot.bin + 1} · ${angleLabel(meta.propagation_enu[dot.bin])} · ${describeValue(dot.value, dot.flag, fieldUnit)}` :
    "方位 / 俯仰 · 北 0°，东 90°";
}

function drawLens() {
  const entry = samples?.selection, frame = activeSnapshot();
  $("point").hidden = !entry || !frame;
  if (!entry || !frame) { lensDots = []; return; }
  const {i, position: [x, y]} = entry;
  const height = frame.points[4 * i + 3];
  const direct = describeValue(frame.data.direct[i], frame.flags.direct[i], "W/m²");
  $("point-reading").textContent = `东 ${x} m · 北 ${y} m · 距地 ${height} m · ${describeValue(entry.value, entry.flag, samples.unit)}` +
    ($("direction").value === "mean" ? ` · ${entry.n}/128` : "");
  $("lens-note").textContent = `金圈 · 太阳直射 ${direct} · 空心灰点为未知`;
  const c = lens.getContext("2d");
  c.clearRect(0, 0, lens.width, lens.height);
  if (lensMetric === "reflection" && frame.reflectionLoaded === false) {
    lensDots = [];
    $("lens-selection").textContent = "正在读取反射方向";
    return;
  }
  const circle = (x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); };
  for (const [x, label] of [[160, "向下传播"], [480, "向上传播"]]) {
    circle(x, disc.y, disc.radius);
    c.fillStyle = "#111b24";
    c.fill();
    c.strokeStyle = "#5b7180";
    c.lineWidth = 1.5;
    c.stroke();
    c.beginPath();
    c.moveTo(x - disc.radius, disc.y); c.lineTo(x + disc.radius, disc.y);
    c.moveTo(x, disc.y - disc.radius); c.lineTo(x, disc.y + disc.radius);
    c.strokeStyle = "#324755"; c.stroke();
    c.font = "21px system-ui";
    c.fillStyle = "#c4d7e2";
    c.textAlign = "center";
    c.fillText(label, x, 298);
    c.font = "17px system-ui";
    c.fillText("北", x, 28);
    c.fillText("东", x + disc.radius + 23, disc.y + 6);
  }
  const fog = fogScales[lensMetric], bins = meta.propagation_enu.length;
  lensDots = meta.propagation_enu.map((direction, bin) => {
    const [x, y] = lensPosition(direction);
    const value = frame.data[lensMetric][i * bins + bin], flag = frame.flags[lensMetric][i * bins + bin];
    const r = flag ? 3.3 + 6 * strength(value, fog.cap) : 3.8;
    circle(x, y, r);
    if (flag) {
      c.fillStyle = `rgb(${shade(value, fog).map(v => Math.round(255 * v)).join(",")})`;
      c.fill();
    } else {
      c.strokeStyle = "#8193a3"; c.stroke();
    }
    if (displayBin === bin && metric === lensMetric) {
      circle(x, y, r + 3.8);
      c.strokeStyle = "#a2f8e5"; c.lineWidth = 2.1; c.stroke(); c.lineWidth = 1.5;
    }
    return {x, y, bin, value, flag};
  });
  const sun = frame.sun;
  if (sun.direction[2] < 0 && sun.dni > 0) {
    const [x, y] = lensPosition(sun.direction);
    circle(x, y, 9);
    c.strokeStyle = "#ffd37e"; c.lineWidth = 2.8; c.stroke();
    if (frame.flags.direct[i] && frame.data.direct[i] > 0) {
      circle(x, y, 4.5); c.fillStyle = "#ffd37e"; c.fill();
    }
  }
  describeBin(metric === lensMetric ? lensDots[displayBin] : null);
}

function lensHit(event) {
  const rect = lens.getBoundingClientRect();
  const x = (event.clientX - rect.left) * lens.width / rect.width;
  const y = (event.clientY - rect.top) * lens.height / rect.height;
  let best, distance = 16;
  for (const dot of lensDots) {
    const d = Math.hypot(dot.x - x, dot.y - y);
    if (d < distance) { best = dot; distance = d; }
  }
  return best;
}

function picked(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  if (area === "volume") {
    const id = renderer.pickVolume(x, y, glState());
    if (id < 0) return;
    const cell = volumes.cell(id);
    $("cut-axis").value = "1";
    $("cut-position").value = cell.y;
    setLensMetric(metric === "direct" ? "scatter" : metric);
    changeArea("full", true, cell.point);
    return;
  }
  const frame = activeSnapshot();
  if (!frame || !samples) return;
  const index = renderer.pick(x, y, glState());
  const selected = samples.visible[index];
  if (selected && metric !== "direct") setLensMetric(metric);
  pickedCell = selected ? {points: frame.points, index: selected.i} : null;
  samples.selection = selected;
  drawLens();
  draw();
  if (wantsReflection() && frame.reflectionLoaded === false) load();
}

function setLensMetric(next) {
  lensMetric = next;
  $("lens-component").value = next;
}

function setMetric(next) {
  if (metric === "direct" && next !== "direct" && $("direction").value === "sun") {
    $("direction").value = "mean";
  }
  metric = next;
  if (next !== "direct") setLensMetric(next);
  for (const item of $("components").children) {
    item.setAttribute("aria-pressed", String(item.dataset.metric === next));
  }
  $("direction").options[0].disabled = next === "direct";
  if (next === "direct" && $("direction").value === "mean") $("direction").value = "sun";
  $("show-field").checked = true;
}

function setAngles(direction) {
  const [az, alt] = angles(direction);
  $("az").value = Math.round(az) % 360;
  $("alt").value = Math.round(alt);
}

function moveCut() {
  pickedCell = null;
  pendingPick = null;
  updateField();
  if (sections && cutMode && $("show-field").checked) {
    request++;
    controller?.abort();
    clearTimeout(timeDelay);
    $("status").textContent = "正在切换剖面";
    timeDelay = setTimeout(load, 100);
  }
}

function refreshDirection() {
  updateField();
  if (area === "volume") {
    request++;
    controller?.abort();
    clearTimeout(timeDelay);
    timeDelay = setTimeout(load, 100);
  }
}

function bind() {
  const timeOptions = demo ? demo.hours.map(h => timeLabel(h).slice(11, 13)) :
    Array.from({length: 24}, (_, i) => String(i).padStart(2, "0"));
  for (const t of timeOptions) {
    $("time-hour").add(new Option(t + ":00", t));
  }
  if (volumes) {
    $("overview").textContent = "全区光场";
    $("section-mode").textContent = "5 米剖切";
    $("show-field").checked = true;
  }
  if (demo) {
    $("date").readOnly = true;
    $("timeline").max = demo.hours.length - 1;
    $("time-ticks").replaceChildren(...timeOptions.map(t => {
      const label = document.createElement("span");
      label.textContent = t + ":00";
      return label;
    }));
    $("height").add(new Option(demo.overviewHeight + " m", demo.overviewHeight));
    $("height").disabled = true;
    $("tile-note").textContent = "北 ↑ · 5 米剖切样区";
    $("prev").setAttribute("aria-label", "上一个时刻");
    $("next").setAttribute("aria-label", "下一个时刻");
    if (sections) {
      $("section-mode").textContent = volumes ? "5 米剖切" : "全区剖切";
      $("cut-position").max = sections.size - 1;
      $("cut-position").value = 118;
      $("tile-note").textContent = "北 ↑ · 点选位置跳转剖面";
    }
  } else {
    $("date").min = timeLabel(0).slice(0, 10);
    $("date").max = timeLabel(meta.hours - 1).slice(0, 10);
    $("height").add(new Option("全部高度", "all"));
    for (let h = 2.5; h < 120; h += 5) $("height").add(new Option(h + " m", h));
    $("height").value = "37.5";
  }
  for (let y = 9; y >= 0; y--) {
    for (let x = 0; x < 10; x++) {
      const b = document.createElement("button");
      b.dataset.tile = `${x}-${y}`;
      b.title = `第 ${x+1} 列，第 ${y+1} 行`;
      b.setAttribute("aria-label", b.title);
      b.setAttribute("aria-pressed", "false");
      if (demo && !sections) {
        b.disabled = b.dataset.tile !== demo.section;
        if (!b.disabled) b.dataset.available = "true";
      }
      b.onclick = () => {
        if (!sections) {
          changeArea(b.dataset.tile, Boolean(demo) || cutMode);
          return;
        }
        const tile = Number($("cut-axis").value) === 0 ? x : y;
        $("cut-position").value = 20 * tile + 10;
        if (cutMode) moveCut(); else changeArea("full", true);
      };
      $("tiles").append(b);
    }
  }
  $("overview").onclick = () => changeArea(volumes ? "volume" : "overview", false);
  $("section-mode").onclick = () => changeArea(sections ? "full" : selectedTile, true);
  updateScopeNote();
  viewControls();
  $("date").onchange = load;
  $("time-hour").onchange = load;
  $("retry").onclick = load;
  $("timeline").oninput = () => {
    const step = $("timeline").value;
    if (demo) {
      chooseTime(demo.hours[Number(step)]);
    } else {
      $("time-hour").value = step.padStart(2, "0");
      if (!stageTime(chosenHour())) return;
    }
    clearTimeout(timeDelay);
    timeDelay = setTimeout(load, demo ? 100 : 360);
  };
  $("timeline").onchange = load;
  for (const [id, delta] of [["prev", -1], ["next", 1]]) {
    $(id).onclick = () => {
      const hour = demo ? demo.hours[demo.hours.indexOf(stageHour) + delta] :
        Math.max(0, Math.min(meta.hours - 1, stageHour + delta));
      chooseTime(hour);
      load();
    };
  }
  $("components").onclick = (event) => {
    const b = event.target.closest("button[data-metric]");
    if (!b) return;
    setMetric(b.dataset.metric);
    if (area !== "volume" && activeSnapshot()) updateField(); else load();
  };
  $("direction").options[0].disabled = true;
  $("direction").onchange = () => {
    exactBin = null;
    const p = enu[$("direction").value];
    if (p) setAngles(p);
    refreshDirection();
  };
  for (const id of ["az", "alt"]) {
    $(id).oninput = () => { exactBin = null; $("direction").value = "custom"; refreshDirection(); };
  }
  $("height").onchange = () => { pickedCell = null; load(); };
  $("show-field").onchange = load;
  $("show-unknown").onchange = updateField;
  $("show-mesh").onchange = updateField;
  $("opacity").oninput = () => {
    $("op-value").textContent = $("opacity").value + "%";
    draw();
  };
  if (volumes) {
    $("volume-top").oninput = () => {
      $("volume-top-value").textContent = $("volume-top").value + " m";
      updateField();
    };
  }
  $("reset").onclick = resetView;
  $("cut-position").oninput = moveCut;
  $("cut-axis").onchange = () => { resetView(); moveCut(); };
  const handle = $("cut-handle");
  handle.onpointerdown = (event) => {
    const slice = section();
    if (!slice) return;
    const axis = slice.axis === 0 ? enu.east : enu.north;
    const normal = projectVector(axis);
    cutDrag = {x: event.clientX, y: event.clientY, index: slice.index, normal};
    handle.setPointerCapture(event.pointerId);
  };
  handle.onpointermove = (event) => {
    if (!cutDrag) return;
    const [nx, ny] = cutDrag.normal;
    const dx = event.clientX - cutDrag.x, dy = event.clientY - cutDrag.y;
    const meters = (dx * nx + dy * ny) / (pixelsPerMeter() * (nx * nx + ny * ny));
    if (!Number.isFinite(meters)) return;
    const index = Math.max(0, Math.min(Number($("cut-position").max), cutDrag.index + Math.round(meters / 5)));
    if (Number($("cut-position").value) === index) return;
    $("cut-position").value = index;
    moveCut();
  };
  handle.onlostpointercapture = () => { cutDrag = null; };
  handle.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const control = $("cut-position");
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") control.stepDown(); else control.stepUp();
    moveCut();
  };
  $("close-point").onclick = () => {
    pickedCell = null;
    if (samples) samples.selection = null;
    drawLens();
    draw();
  };
  $("lens-component").onchange = () => {
    setLensMetric($("lens-component").value);
    drawLens();
    if (wantsReflection() && activeSnapshot()?.reflectionLoaded === false) load();
  };
  lens.onpointermove = (event) => describeBin(lensHit(event) ?? (metric === lensMetric ? lensDots[displayBin] : null));
  lens.onpointerleave = () => describeBin(metric === lensMetric ? lensDots[displayBin] : null);
  lens.onclick = (event) => {
    const dot = lensHit(event);
    if (!dot) return;
    setMetric(lensMetric);
    exactBin = dot.bin;
    $("direction").value = "custom";
    setAngles(meta.propagation_enu[dot.bin]);
    updateField();
  };
  canvas.onpointerdown = (e) => {
    drag = {x: e.clientX, y: e.clientY, d: 0};
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const dx = e.clientX-drag.x, dy = e.clientY-drag.y;
    drag.d += Math.hypot(dx, dy);
    if (e.shiftKey) {
      const s = pixelsPerMeter();
      orbit.target[0] -= (dx*Math.cos(orbit.yaw) + dy*Math.sin(orbit.yaw)) / s;
      orbit.target[1] += (dx*Math.sin(orbit.yaw) - dy*Math.cos(orbit.yaw)) / s;
    } else {
      orbit.yaw += dx*.006;
      orbit.pitch = Math.max(.16, Math.min(1.55, orbit.pitch + dy*.007));
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    draw();
  };
  canvas.onpointerup = (e) => { if (drag?.d < 4) picked(e); drag = null; draw(); };
  canvas.onpointercancel = () => { drag = null; draw(); };
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    orbit.zoom = Math.max(.4, Math.min(22, orbit.zoom * Math.exp(-e.deltaY*.001)));
    draw();
  }, {passive: false});
  new ResizeObserver(draw).observe(canvas);
}

async function init() {
  try {
    let createVolumePass;
    if (document.body.hasAttribute("data-demo")) {
      const manifest = document.body.dataset.demo || "demo.json";
      demo = await (await get(`./${manifest}`)).json();
      meta = demo.meta;
      selectedTile = demo.section;
      if (demo.sectionData) {
        const {openSections} = await import("./sections.mjs?v=2");
        sections = await openSections(demo.sectionData, demo);
      }
      if (demo.volumeData) {
        const api = await import("./volume.mjs?v=1");
        volumes = await api.openVolume(demo.volumeData, demo, sections?.voxels);
        createVolumePass = api.makeVolumePass;
        area = "volume";
      }
      const view = volumes ? "5 米全区体渲染" : sections ? "全区 5 米剖切" : "5 米剖切";
      $("summary").textContent = `1 km² 实景 · ${view} · ${demo.hours.length} 个时刻`;
    } else {
      const [info, solar] = await Promise.all([
        get("./api/meta").then(r => r.json()),
        get("./api/sun").then(r => r.arrayBuffer()),
      ]);
      meta = info;
      if (solar.byteLength !== meta.hours * 16) throw Error("全年太阳方向数据长度不一致");
      solarTrack = new Float32Array(solar);
      $("summary").textContent = `1 km² · 5 米网格 · ${meta.voxels.toLocaleString("zh-CN")} 个空气体素 · ${meta.hours.toLocaleString("zh-CN")} 小时`;
    }
    renderer = makeRenderer(canvas, createVolumePass);
    if (volumes) renderer.setVolumeGrid(volumes.meta, volumes.ground);
    bind();
    if (volumes) resetView();
    const firstLight = demo?.hours[0] ?? Math.max(0, meta.default_hour - 8);
    chooseTime(firstLight);
    load();
    const texture = new Image();
    texture.src = "./texture.jpg";
    const [model] = await Promise.all([
      get("./api/mesh").then((r) => r.arrayBuffer()),
      texture.decode(),
    ]);
    renderer.setMesh(model, texture);
    if (!renderer.supportsShadows) $("coverage").textContent = "当前浏览器的 WebGL 不支持阴影贴图";
    draw();
  } catch (error) {
    $("stamp").textContent = "加载失败";
    $("status").textContent = error.message;
  }
}

init();
