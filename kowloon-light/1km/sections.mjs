// Assemble one full-width cut from the same native tiles in either orientation.
async function binary(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`光场地块读取失败（${response.status}）`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
  if (bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8) return buffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function sharedCache(maxEntries, load) {
  const entries = new Map();
  return url => {
    const existing = entries.get(url);
    const pending = existing ?? load(url).catch(error => {
      if (entries.get(url) === pending) entries.delete(url);
      throw error;
    });
    entries.delete(url);
    entries.set(url, pending);
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return pending;
  };
}

function decodeBase(buffer, meta) {
  const n = new DataView(buffer).getUint32(0, true);
  const slotBytes = n * (meta.bins / 8 + meta.bins + 1);
  const start = 4 + 16 * n;
  if (n > meta.tileSize ** 2 * 24 || buffer.byteLength !== start + meta.hours.length * slotBytes) {
    throw Error("原始体素地块长度不一致");
  }
  return {n, start, slotBytes, buffer, points: new Float32Array(buffer, 4, n * 4)};
}

function cutRows(tile, axis, position) {
  const rows = [];
  for (let i = 0; i < tile.n; i++) {
    if (tile.points[4 * i + axis] === position) rows.push(i);
  }
  return rows;
}

function copyTile(tile, rows, reflectionBytes, slot, meta, field, start) {
  const {n, buffer, points} = tile;
  const {bins} = meta;
  const offset = tile.start + slot * tile.slotBytes;
  const maskLength = n * bins / 8;
  const mask = new Uint8Array(buffer, offset, maskLength);
  const scatterFlags = new Uint8Array(buffer, offset + maskLength, n * bins);
  const directs = new Uint8Array(buffer, offset + maskLength + n * bins, n);
  const entries = n * bins;
  if (reflectionBytes && reflectionBytes.byteLength !== entries * 5) {
    throw Error("反射地块与体素索引不一致");
  }
  const {data, flags} = field;
  const reflectionBits = reflectionBytes ? new Uint32Array(data.reflection.buffer) : null;
  const reflected = reflectionBytes ? new Uint8Array(reflectionBytes) : null;
  for (let i = 0; i < rows.length; i++) {
    const src = rows[i], dst = start + i;
    field.points.set(points.subarray(src * 4, src * 4 + 4), dst * 4);
    const state = directs[src];
    data.direct[dst] = state & 4 ? meta.sun[slot].dni : 0;
    flags.direct[dst] = state & 3;
    for (let d = 0; d < bins; d++) {
      const bin = src * bins + d, target = dst * bins + d;
      data.scatter[target] = mask[bin >> 3] & (1 << (bin & 7)) ? meta.scatter[slot][d] : 0;
      flags.scatter[target] = scatterFlags[bin];
      if (reflected) {
        const k = d * n + src;
        reflectionBits[target] = reflected[k] | (reflected[k + entries] << 8) |
          (reflected[k + entries * 2] << 16) | (reflected[k + entries * 3] << 24);
        flags.reflection[target] = reflected[entries * 4 + bin];
      }
    }
  }
}

export async function openSections(path, demo) {
  const indexURL = new URL(path, document.baseURI);
  const response = await fetch(indexURL);
  if (!response.ok) throw Error(`全区剖切清单读取失败（${response.status}）`);
  const meta = await response.json();
  if (meta.format !== "kowloon-section-tiles-v1" || meta.sourceCommit !== demo.sourceCommit ||
      meta.bins !== demo.meta.propagation_enu.length || meta.hours.length !== demo.hours.length ||
      meta.hours.some((hour, i) => hour !== demo.hours[i]) || meta.size !== 200 ||
      meta.origin !== -497.5 || meta.step !== 5 || meta.tileSize !== 5) {
    throw Error("全区剖切清单与演示数据不一致");
  }
  const readBase = sharedCache(160, async url => decodeBase(await binary(url), meta));
  const readReflection = sharedCache(90, binary);
  const side = meta.size / meta.tileSize;
  const position = index => meta.origin + meta.step * index;
  return {
    size: meta.size,
    origin: meta.origin - meta.step / 2,
    span: meta.size * meta.step,
    voxels: meta.voxels,
    position,
    async read(axis, index, hour, reflection, signal) {
      const slot = meta.hours.indexOf(hour);
      if (slot < 0 || ![0, 1].includes(axis) || !Number.isInteger(index) || index < 0 || index >= meta.size) {
        throw Error("剖切面超出可用数据范围");
      }
      const band = Math.floor(index / meta.tileSize);
      const folders = Array.from({length: side}, (_, i) => {
        const tile = (axis === 0 ? [band, i] : [i, band]).map(n => String(n).padStart(2, "0"));
        return new URL(`tiles/${tile.join("-")}/`, indexURL);
      });
      const bases = await Promise.all(folders.map(folder => readBase(new URL("base.bin.gz", folder).href)));
      signal.throwIfAborted();
      const rows = bases.map(tile => cutRows(tile, axis, position(index)));
      const count = rows.reduce((sum, ids) => sum + ids.length, 0);
      const reflected = reflection ? await Promise.all(folders.map((folder, i) => rows[i].length ?
        readReflection(new URL(`reflection-${hour}.bin.gz`, folder).href) : null)) : [];
      signal.throwIfAborted();
      const directional = count * meta.bins;
      const field = {
        points: new Float32Array(count * 4),
        data: {scatter: new Float32Array(directional), direct: new Float64Array(count)},
        flags: {scatter: new Uint8Array(directional), direct: new Uint8Array(count)},
        reflectionLoaded: reflection,
      };
      if (reflection) {
        field.data.reflection = new Float32Array(directional);
        field.flags.reflection = new Uint8Array(directional);
      }
      let start = 0;
      for (let i = 0; i < bases.length; i++) {
        copyTile(bases[i], rows[i], reflected[i], slot, meta, field, start);
        start += rows[i].length;
      }
      return field;
    },
  };
}
