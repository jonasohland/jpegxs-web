// Minimal MP4 demuxer for the first H.264 video track of a non-fragmented
// file (moov + mdat). Reads the whole file into memory, then expands the
// sample tables. Enough for data/bbb.mp4; not a general-purpose parser.

/** Iterates the child boxes in `view[start, end)`. */
function* boxes(view, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5), view.getUint8(pos + 6), view.getUint8(pos + 7));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) throw new Error(`mp4: bad box '${type}' at ${pos}`);
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function child(view, box, type) {
  for (const b of boxes(view, box.start, box.end)) if (b.type === type) return b;
  return null;
}

function path(view, box, ...types) {
  for (const t of types) {
    box = box && child(view, box, t);
  }
  return box;
}

const hex2 = (v) => v.toString(16).padStart(2, "0");

/**
 * Fetches `url` and returns the first video track as WebCodecs objects:
 * `{ config: VideoDecoderConfig, samples: EncodedVideoChunkInit[] }` with
 * samples in decode order.
 */
export async function demuxMp4(url, onProgress = () => {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  const total = Number(response.headers.get("Content-Length")) || 0;
  const chunks = [];
  let received = 0;
  for (const reader = response.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const file = new Uint8Array(received);
  for (let off = 0, i = 0; i < chunks.length; off += chunks[i++].length) file.set(chunks[i], off);
  return { file, ...parseMp4(file) };
}

export function parseMp4(file) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const root = { start: 0, end: file.byteLength };
  const moov = child(view, root, "moov");
  if (!moov) throw new Error("mp4: no moov box (fragmented files are not supported)");

  for (const trak of boxes(view, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const hdlr = path(view, trak, "mdia", "hdlr");
    if (!hdlr || view.getUint32(hdlr.start + 8) !== 0x76696465 /* 'vide' */) continue;
    return parseVideoTrak(view, file, trak);
  }
  throw new Error("mp4: no video track");
}

function parseVideoTrak(view, file, trak) {
  const mdhd = path(view, trak, "mdia", "mdhd");
  const timescale = view.getUint8(mdhd.start) === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12);
  const stbl = path(view, trak, "mdia", "minf", "stbl");

  // stsd: first sample entry (VisualSampleEntry: 78 bytes before its children).
  const stsd = child(view, stbl, "stsd");
  const entry = boxes(view, stsd.start + 8, stsd.end).next().value;
  if (entry.type !== "avc1" && entry.type !== "avc3") {
    throw new Error(`mp4: unsupported video codec '${entry.type}' (only H.264 is handled)`);
  }
  const codedWidth = view.getUint16(entry.start + 24);
  const codedHeight = view.getUint16(entry.start + 26);
  const avcC = child(view, { start: entry.start + 78, end: entry.end }, "avcC");
  if (!avcC) throw new Error("mp4: no avcC box");
  const description = file.slice(avcC.start, avcC.end);
  const codec = `avc1.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`;

  // Sample sizes.
  const stsz = child(view, stbl, "stsz");
  const fixedSize = view.getUint32(stsz.start + 4);
  const count = view.getUint32(stsz.start + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixedSize || view.getUint32(stsz.start + 12 + 4 * i);

  // Chunk offsets.
  const stco = child(view, stbl, "stco");
  const co64 = child(view, stbl, "co64");
  const chunkOffsets = [];
  if (stco) {
    const n = view.getUint32(stco.start + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(view.getUint32(stco.start + 8 + 4 * i));
  } else {
    const n = view.getUint32(co64.start + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(Number(view.getBigUint64(co64.start + 8 + 8 * i)));
  }

  // Sample offsets from the sample-to-chunk runs.
  const stsc = child(view, stbl, "stsc");
  const runs = view.getUint32(stsc.start + 4);
  const offsets = new Float64Array(count);
  let sample = 0;
  for (let r = 0; r < runs; r++) {
    const base = stsc.start + 8 + 12 * r;
    const firstChunk = view.getUint32(base) - 1;
    const perChunk = view.getUint32(base + 4);
    const lastChunk = r + 1 < runs ? view.getUint32(base + 12) - 1 : chunkOffsets.length;
    for (let c = firstChunk; c < lastChunk && sample < count; c++) {
      let off = chunkOffsets[c];
      for (let s = 0; s < perChunk && sample < count; s++) {
        offsets[sample] = off;
        off += sizes[sample++];
      }
    }
  }

  // Decode times (stts), composition offsets (ctts) and sync samples (stss).
  const dts = new Float64Array(count);
  const stts = child(view, stbl, "stts");
  for (let e = 0, i = 0, t = 0, n = view.getUint32(stts.start + 4); e < n; e++) {
    const runCount = view.getUint32(stts.start + 8 + 8 * e);
    const delta = view.getUint32(stts.start + 12 + 8 * e);
    for (let k = 0; k < runCount && i < count; k++, t += delta) dts[i++] = t;
  }
  const cts = new Float64Array(count);
  const ctts = child(view, stbl, "ctts");
  if (ctts) {
    const signed = view.getUint8(ctts.start) === 1;
    for (let e = 0, i = 0, n = view.getUint32(ctts.start + 4); e < n; e++) {
      const runCount = view.getUint32(ctts.start + 8 + 8 * e);
      const off = signed ? view.getInt32(ctts.start + 12 + 8 * e) : view.getUint32(ctts.start + 12 + 8 * e);
      for (let k = 0; k < runCount && i < count; k++) cts[i++] = off;
    }
  }
  const stss = child(view, stbl, "stss");
  const sync = new Uint8Array(count).fill(stss ? 0 : 1);
  if (stss) {
    for (let e = 0, n = view.getUint32(stss.start + 4); e < n; e++) sync[view.getUint32(stss.start + 8 + 4 * e) - 1] = 1;
  }

  // Instead of applying the edit list, start presentation at 0.
  let first = Infinity;
  for (let i = 0; i < count; i++) first = Math.min(first, dts[i] + cts[i]);

  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push({
      type: sync[i] ? "key" : "delta",
      timestamp: Math.round(((dts[i] + cts[i] - first) * 1e6) / timescale),
      duration: i + 1 < count ? Math.round(((dts[i + 1] - dts[i]) * 1e6) / timescale) : 0,
      data: file.subarray(offsets[i], offsets[i] + sizes[i]),
    });
  }
  return { config: { codec, codedWidth, codedHeight, description }, samples };
}
