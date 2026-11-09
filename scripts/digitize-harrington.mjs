#!/usr/bin/env node
// TASK-101: digitizes NACA TN 2318 (Harrington 1951, public domain) figures 1(a), 4 and 8 into
// tests/fixtures/rotors/harrington-coaxial.json (SPECS_SIMULATION_ENGINES "Measured coaxial rotors: NACA TN 2318").
//
//   node scripts/digitize-harrington.mjs --pages DIR [--out FILE] [--overlay DIR]
//
// DIR holds the page images p11.png, p19.png and p23.png, rendered from NACA-TN-2318-clean.pdf at 1.6 times its point size;
// each is checked by SHA-256. The axes are calibrated from the grid lines found in the images: each line's position is the
// darkness centroid in bands along it, fitted by a straight line (the scan is slightly skewed), and a point's value is
// interpolated between the two neighbouring lines at its own height or width. The symbol centres were read by eye from 4 to
// 12 times enlarged crops of the same images (each symbol carries a centre dot; where the dot is hidden the outline's centre
// is used) and are listed below in page pixels; `--overlay` writes the plots with each reading marked, for checking.
// Exit 0 on success, 1 on a failed check, 2 when an input is missing.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const PDF_SHA256 = '78e327b96dd4aaf8ab07dce706cb424bfb2c6c239f0fe9a62a847a920d056acf';
const PAGES = {
  p11: '7cb0559faf3354abe91043ba505b900a2eb51a37b6de95cd3727af6124e1f970',
  p19: 'e3b98ebd714f60362255ff7fb637df75aa973a5d7dfa0a55427c0170d8fa5d7f',
  p23: '287cef900e09e039a0180729b0b536afe3d9cb3eefac4f77aeaacbc0a5f54a66',
};
/** Reading uncertainty of a symbol centre, page pixels: a visible centre dot, and a hidden dot or overlapping outlines. */
const READING_PX = Object.freeze({ dot: 2, outline: 4 });

/**
 * Each figure's axes: the vertical lines carry x values from `x.first` in steps of `x.step` (`x.count` lines from the first
 * guess `x.at` with spacing `x.spacing` pixels); the horizontal lines likewise for y, counted upward from the bottom line.
 * `box` bounds the bands the lines are measured in, [x0, y0, x1, y1].
 */
const FIGURES = {
  fig8: { page: 'p23', box: [432, 463, 1653, 1550],
    x: { first: 0, step: 0.00005, count: 21, at: 430, spacing: 61.2 }, y: { first: 0, step: 0.0005, count: 19, at: 1552, spacing: -60.6 } },
  fig4: { page: 'p19', box: [377, 510, 1555, 1532],
    x: { first: 0, step: 0.00005, count: 17, at: 375.5, spacing: 73.9 }, y: { first: 0, step: 0.0005, count: 15, at: 1534, spacing: -73.3 } },
  fig1a: { page: 'p11', box: [423, 608, 1569, 1748],
    x: { first: 0, step: 10, count: 17, at: 421, spacing: 71.9 }, y: { first: 0, step: 1, count: 17, at: 1750, spacing: -71.5 } },
};

// Symbol centres [x, y] in page pixels, read from the enlarged crops; a third element 'outline' marks a centre taken from
// the outline because the dot is hidden or the outlines overlap.
const SERIES = [
  // Figure 8 (rotor 2): the legend gives the symbols.
  { id: 'r2-coaxial-392', figure: 'fig8', rotor: 2, configuration: 'coaxial', solidity: 0.152, tipSpeedFps: 392, symbol: 'circle', points: [
    [1301, 720.5, 'outline'], [1296.5, 727.5, 'outline'], [1141.8, 858.3], [1102.5, 894.3], [944.5, 1046.3], [919.3, 1067, 'outline'],
    [772.5, 1286.8], [754.3, 1305.3, 'outline']] },
  { id: 'r2-coaxial-327', figure: 'fig8', rotor: 2, configuration: 'coaxial', solidity: 0.152, tipSpeedFps: 327, symbol: 'square', points: [
    [1599.3, 497], [1623.8, 488], [1375, 648.8], [1414.3, 647.5], [1218.8, 773.8], [1206.8, 799], [1034, 949, 'outline'],
    [1044, 942.5, 'outline'], [905.8, 1080.3], [918.3, 1091.5], [759.3, 1282], [744.3, 1316.3]] },
  { id: 'r2-single-lower-262', figure: 'fig8', rotor: 2, configuration: 'single-lower', solidity: 0.076, tipSpeedFps: 262, symbol: 'diamond', points: [
    [1083, 847.5], [967, 948.3], [903.8, 1003.8], [870.5, 1044], [780.8, 1161.3], [736.5, 1189.5, 'outline'], [739, 1190.5, 'outline'],
    [684, 1265.3], [649.5, 1323.8, 'outline'], [648.8, 1338, 'outline'], [603.8, 1407], [595.8, 1431.5], [585, 1447.8]] },
  { id: 'r2-single-lower-392', figure: 'fig8', rotor: 2, configuration: 'single-lower', solidity: 0.076, tipSpeedFps: 392, symbol: 'triangle', points: [
    [721.3, 1227.5], [668.3, 1296.3]] },
  // Figure 4 (rotor 1).
  { id: 'r1-coaxial-500', figure: 'fig4', rotor: 1, configuration: 'coaxial', solidity: 0.054, tipSpeedFps: 500, symbol: 'circle', points: [
    [1059.3, 716], [997.3, 770.3], [952.3, 811], [899.3, 859.3], [830.3, 915], [776.8, 973.3, 'outline'], [783.8, 985], [728.3, 1050.8],
    [711.3, 1075.3], [681.3, 1091.8], [647.5, 1153.8], [637, 1168.8], [587, 1232, 'outline'], [598, 1233, 'outline'], [556.3, 1310.5],
    [525.5, 1383], [506.8, 1436.3], [494.3, 1499.3], [486.3, 1530.5, 'outline']] },
  { id: 'r1-coaxial-450', figure: 'fig4', rotor: 1, configuration: 'coaxial', solidity: 0.054, tipSpeedFps: 450, symbol: 'square', points: [
    [1165.7, 617], [1054.3, 699.3], [957.3, 788.7], [888, 861.3, 'outline'], [750.8, 1000], [667.5, 1110, 'outline'], [584, 1238, 'outline']] },
  { id: 'r1-coaxial-327', figure: 'fig4', rotor: 1, configuration: 'coaxial', solidity: 0.054, tipSpeedFps: 327, symbol: 'diamond', points: [
    [1151.7, 655.7, 'outline'], [1081, 712.3], [987.7, 795.7], [911, 890.7], [850.7, 971.7], [767.5, 1070.3], [708.3, 1140.5], [662, 1195],
    [611.3, 1281.3]] },
  // Single lower (triangle) and single upper (right triangle) at 500 ft/s; where a symbol is hidden its kind is not told apart,
  // and the comparison takes all three as one single rotor (the report draws one curve through them).
  { id: 'r1-single-lower-500', figure: 'fig4', rotor: 1, configuration: 'single-lower', solidity: 0.027, tipSpeedFps: 500, symbol: 'triangle', points: [
    [723.1, 1025], [660.8, 1077.5], [632, 1120], [608.3, 1145.5], [545.8, 1230.5], [530.5, 1258.8], [504.5, 1307.5], [473, 1378],
    [455, 1423.3], [436, 1482.6], [424.6, 1506], [421, 1536, 'outline'], [434, 1536, 'outline']] },
  { id: 'r1-single-upper-500', figure: 'fig4', rotor: 1, configuration: 'single-upper', solidity: 0.027, tipSpeedFps: 500, symbol: 'right-triangle', points: [
    [564.5, 1210.8], [526, 1270], [490.3, 1325.3, 'outline'], [476.8, 1350.8], [461.3, 1392.5], [444.5, 1426.3, 'outline'], [432.4, 1472.6, 'outline'],
    [421, 1518.3, 'outline'], [424.7, 1528.3, 'outline']] },
  { id: 'r1-single-unidentified-500', figure: 'fig4', rotor: 1, configuration: 'single', solidity: 0.027, tipSpeedFps: 500, symbol: 'triangle-hidden', points: [
    [745.9, 1017.1, 'outline'], [657, 1097.5, 'outline'], [577, 1189.5]] },
];
/** Figure 1(a): the chord line of rotor 1 is sampled at these page columns (radius 25 to 143 in), searched near `guess`. */
const CHORD_COLUMNS = [600, 650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350, 1400, 1450];
const chordGuess = x => 960 + (x - 600) * 0.53;

function fail(message, code = 1) { console.error(message); process.exit(code); }
function args() {
  const out = { pages: '', out: 'tests/fixtures/rotors/harrington-coaxial.json', overlay: '' };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    const key = a[i], value = a[i + 1];
    if (value === undefined) fail(`Missing value for ${key}`, 2);
    if (key === '--pages') out.pages = value; else if (key === '--out') out.out = value; else if (key === '--overlay') out.overlay = value;
    else fail(`Unknown option ${key}`, 2);
  }
  if (out.pages === '') fail('Usage: node scripts/digitize-harrington.mjs --pages DIR [--out FILE] [--overlay DIR]', 2);
  return out;
}

/** An 8-bit, non-interlaced PNG as luminance 0..255. */
function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let o = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (o < bytes.length) {
    const length = bytes.readUInt32BE(o), type = bytes.toString('latin1', o + 4, o + 8), data = bytes.subarray(o + 8, o + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  if (depth !== 8 || interlace !== 0 || channels === undefined) throw new Error(`Unsupported PNG depth ${depth} colour ${color} interlace ${interlace}`);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0, b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let v = raw[line + x];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}`);
      pixels[y * stride + x] = v & 255;
    }
  }
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    gray[i] = channels >= 3 ? Math.round(0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2]) : pixels[p];
  }
  return { width, height, gray };
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { let c = (crc ^ byte) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function encodeRgbPng(width, height, rgb) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const round = (value, digits) => Number(value.toFixed(digits));
/** Least-squares a + b t with the residual RMS. */
function fitLine(t, v) {
  const n = t.length, mt = t.reduce((s, x) => s + x, 0) / n, mv = v.reduce((s, x) => s + x, 0) / n;
  let stt = 0, stv = 0;
  for (let i = 0; i < n; i++) { stt += (t[i] - mt) ** 2; stv += (t[i] - mt) * (v[i] - mv); }
  const b = stv / stt, a = mv - b * mt;
  const rms = Math.sqrt(t.reduce((s, x, i) => s + (v[i] - a - b * x) ** 2, 0) / n);
  return { a, b, rms };
}

/**
 * One grid line's position along its length: in bands of 40 pixels, the darkness-weighted centroid within ±5 pixels of the
 * expected position (darkness 255 - luminance above 60, the paper's own level removed); a band whose peak darkness is below 100
 * (the line hidden by a legend or broken) is skipped; the band positions are fitted by a straight line, refitted once without
 * bands more than 1 pixel off.
 */
function measureLine(image, vertical, expected, from, to) {
  const { width, gray } = image, at = [], pos = [];
  for (let start = from; start + 40 <= to; start += 40) {
    let sum = 0, weight = 0, peak = 0;
    for (let along = start; along < start + 40; along++) {
      for (let off = -5; off <= 5; off++) {
        const across = Math.round(expected) + off, x = vertical ? across : along, y = vertical ? along : across;
        const dark = 255 - gray[y * width + x] - 60;
        if (dark <= 0) continue;
        sum += dark * across; weight += dark;
      }
    }
    for (let off = -5; off <= 5; off++) {
      let column = 0;
      for (let along = start; along < start + 40; along++) {
        const across = Math.round(expected) + off, x = vertical ? across : along, y = vertical ? along : across;
        column += 255 - gray[y * width + x];
      }
      peak = Math.max(peak, column / 40);
    }
    if (weight > 0 && peak >= 100) { at.push(start + 20); pos.push(sum / weight); }
  }
  if (at.length < 3) throw new Error(`Grid line near ${expected} has fewer than three usable bands`);
  let fit = fitLine(at, pos);
  const keep = at.map((t, i) => Math.abs(pos[i] - fit.a - fit.b * t) <= 1);
  if (keep.some(k => !k) && keep.filter(Boolean).length >= 3) fit = fitLine(at.filter((_, i) => keep[i]), pos.filter((_, i) => keep[i]));
  return { ...fit, bands: at.length };
}
function calibrate(image, figure) {
  const [x0, y0, x1, y1] = figure.box;
  const axis = (spec, vertical) => Array.from({ length: spec.count }, (_, k) => {
    const line = measureLine(image, vertical, spec.at + k * spec.spacing, vertical ? y0 : x0, vertical ? y1 : x1);
    return { value: spec.first + k * spec.step, a: line.a, b: line.b, rms: line.rms, bands: line.bands };
  });
  return { x: axis(figure.x, true), y: axis(figure.y, false) };
}
/** The value at `p` across the lines (each at `a + b t`, t the coordinate along it), linear between neighbours. */
function valueAt(lines, p, t) {
  const at = lines.map(line => line.a + line.b * t);
  let k = 0;
  const increasing = at[at.length - 1] > at[0];
  while (k < at.length - 2 && (increasing ? p > at[k + 1] : p < at[k + 1])) k++;
  const step = lines[k + 1].value - lines[k].value, spacing = at[k + 1] - at[k];
  return { value: lines[k].value + (p - at[k]) / spacing * step, perPixel: Math.abs(step / spacing) };
}
function toValues(calibration, x, y) {
  const vx = valueAt(calibration.x, x, y), vy = valueAt(calibration.y, y, x);
  return { x: vx.value, y: vy.value, xPerPixel: vx.perPixel, yPerPixel: vy.perPixel };
}
function calibrationSummary(calibration) {
  const of = lines => {
    const positions = lines.map(line => line.a), fit = fitLine(lines.map(line => line.value), positions);
    return { lines: lines.length, maxLineRmsPx: round(Math.max(...lines.map(line => line.rms)), 3), maxSkewPxPer1000: round(1000 * Math.max(...lines.map(line => Math.abs(line.b))), 2),
      uniformSpacingRmsPx: round(fit.rms, 3), lines_: lines.map(line => ({ value: line.value, a: round(line.a, 3), b: round(line.b, 6), rmsPx: round(line.rms, 3), bands: line.bands })) };
  };
  const x = of(calibration.x), y = of(calibration.y);
  return { x: { ...x, lines_: undefined, positions: x.lines_ }, y: { ...y, lines_: undefined, positions: y.lines_ } };
}

function overlay(image, figure, readings, path) {
  const [x0, y0, x1, y1] = figure.box, w = x1 - x0 + 1, h = y1 - y0 + 1, rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const g = image.gray[(y + y0) * image.width + x + x0]; rgb.set([g, g, g], (y * w + x) * 3); }
  for (const [px, py] of readings) {
    const cx = Math.round(px) - x0, cy = Math.round(py) - y0;
    for (let d = -6; d <= 6; d++) for (const [x, y] of [[cx + d, cy], [cx, cy + d]]) if (x >= 0 && y >= 0 && x < w && y < h) rgb.set([220, 0, 0], (y * w + x) * 3);
  }
  writeFileSync(path, encodeRgbPng(w, h, rgb));
}

function main() {
  const options = args(), images = {}, pageHashes = {};
  for (const [page, sha256] of Object.entries(PAGES)) {
    const path = join(options.pages, `${page}.png`);
    if (!existsSync(path)) fail(`Missing page image ${path}`, 2);
    const bytes = readFileSync(path), hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== sha256) fail(`${path}: SHA-256 ${hash}, expected ${sha256}`);
    images[page] = decodePng(bytes); pageHashes[page] = hash;
  }
  const calibrations = Object.fromEntries(Object.entries(FIGURES).map(([id, figure]) => [id, calibrate(images[figure.page], figure)]));
  const series = SERIES.map(s => {
    const calibration = calibrations[s.figure];
    return {
      id: s.id, figure: s.figure === 'fig8' ? 8 : 4, rotor: s.rotor, configuration: s.configuration, solidity: s.solidity, tipSpeedFps: s.tipSpeedFps, symbol: s.symbol,
      points: s.points.map(([x, y, kind]) => {
        const v = toValues(calibration, x, y), reading = kind === 'outline' ? READING_PX.outline : READING_PX.dot;
        const lineRms = Math.max(...calibration.x.map(line => line.rms), ...calibration.y.map(line => line.rms));
        const px = Math.hypot(reading, lineRms);
        return { px: [x, y], centre: kind === 'outline' ? 'outline' : 'dot', cq: round(v.x, 8), ct: round(v.y, 7),
          uCq: round(px * v.xPerPixel, 8), uCt: round(px * v.yPerPixel, 7) };
      }),
    };
  });
  // Figure 1(a): the chord line of rotor 1, darkness centroid within ±6 px of the guess, away from the horizontal grid lines.
  const fig1a = calibrations.fig1a, image = images.p11, chord = [];
  for (const x of CHORD_COLUMNS) {
    const lines = fig1a.y.map(line => line.a + line.b * x);
    let sum = 0, weight = 0;
    for (let y = Math.round(chordGuess(x)) - 6; y <= Math.round(chordGuess(x)) + 6; y++) {
      if (lines.some(line => Math.abs(line - y) < 3)) continue;
      const dark = 255 - image.gray[y * image.width + x] - 60;
      if (dark > 0) { sum += dark * y; weight += dark; }
    }
    if (weight === 0) continue;
    const v = toValues(fig1a, x, sum / weight);
    chord.push({ px: [x, round(sum / weight, 2)], radiusIn: round(v.x, 3), chordIn: round(v.y, 4) });
  }
  if (chord.length < 10) fail(`Only ${chord.length} chord samples found in figure 1(a)`);
  const chordFit = fitLine(chord.map(c => c.radiusIn), chord.map(c => c.chordIn));
  const fixture = {
    schemaVersion: 1, kind: 'harrington-coaxial', task: 'TASK-101',
    source: {
      report: 'Harrington, R. D.: Full-Scale-Tunnel Investigation of the Static-Thrust Performance of a Coaxial Helicopter Rotor. NACA TN 2318, March 1951',
      license: 'US Government work (NACA), public domain',
      pdf: { file: 'NACA-TN-2318-clean.pdf', sha256: PDF_SHA256, note: 'The NTRS download NACA-TN-2318.pdf with its 436-byte wrapper before %PDF removed' },
      pageImages: Object.entries(pageHashes).map(([page, sha256]) => ({ file: `${page}.png`, sha256,
        content: page === 'p11' ? 'figure 1(a), report page 9' : page === 'p19' ? 'figure 4, report page 17' : 'figure 8, report page 21' })),
      rendering: 'Each PDF page rendered at 1.6 times its point size (1805 by about 2380 pixels)',
    },
    definitions: {
      ct: 'C_T = T / (rho pi R^2 (Omega R)^2), T the thrust of the whole configuration (both rotors of a coaxial one), on one disk area',
      cq: 'C_Q = Q / (rho pi R^2 (Omega R)^2 R), Q the torque of the whole configuration',
      check: 'The report figure of merit M = 0.707 C_T^1.5 / C_Q gives its stated maxima (0.635 coaxial, 0.615 single, rotor 1) with these definitions',
    },
    method: {
      calibration: 'Grid lines found in the page image: darkness centroid in 40-pixel bands within 5 pixels of the expected line, fitted by a straight line; a value is interpolated between the neighbouring lines at the point',
      reading: 'Symbol centres read by eye from 4 to 12 times enlarged crops; the centre dot where visible, the outline centre where the dot is hidden or outlines overlap',
      readingUncertaintyPx: READING_PX,
      uncertainty: 'uCq, uCt: the reading uncertainty combined with the largest grid-line fit RMS, times the local value per pixel; one standard uncertainty of the digitization only, not of the measurement',
      notIncluded: 'The accuracy with which the 1951 draftsman placed each symbol, and the measurement itself',
    },
    calibration: Object.fromEntries(['fig8', 'fig4', 'fig1a'].map(id => [id, calibrationSummary(calibrations[id])])),
    rotors: [
      { rotor: 1, figure: 4, radiusIn: 150, blades: 2, hubSpacingFt: 2.33, hub: 'teetering (seesaw flapping), rigid in plane', twist: 'none',
        airfoil: 'NACA four-digit symmetrical, thickness tapered (figure 1(a))', solidityCoaxial: 0.054, soliditySingle: 0.027, rootOverTipChord: 2.92,
        chord: { from: 'figure 1(a), the chord line sampled and fitted by c = c0 + slope r', c0In: round(chordFit.a, 3), slopeInPerIn: round(chordFit.b, 5),
          rmsIn: round(chordFit.rms, 4), samples: chord },
        rootCutoutIn: { value: 20, uncertaintyIn: 2, from: 'figure 1(a): the chord and thickness lines start at 20 in, dashed inboard' } },
      { rotor: 2, figure: 8, radiusIn: 150, blades: 2, hubSpacingFt: 2.0, hub: 'rigid', twist: 'none',
        airfoil: 'NACA four-digit symmetrical, t/c about 30 % at the root to 15 % at the tip (figure 1(b))', solidityCoaxial: 0.152, soliditySingle: 0.076,
        chord: { from: 'report text and figure 1(b): constant 18 in', c0In: 18, slopeInPerIn: 0 },
        rootCutoutIn: { value: 30, uncertaintyIn: 2, from: 'figure 1(b): the chord and thickness lines are dashed inboard of about 30 in' } },
    ],
    series,
  };
  writeFileSync(options.out, `${JSON.stringify(fixture, null, 2)}\n`);
  if (options.overlay !== '') {
    mkdirSync(options.overlay, { recursive: true });
    for (const id of ['fig8', 'fig4']) overlay(images[FIGURES[id].page], FIGURES[id], SERIES.filter(s => s.figure === id).flatMap(s => s.points), join(options.overlay, `${id}.png`));
    overlay(images.p11, FIGURES.fig1a, chord.map(c => c.px), join(options.overlay, 'fig1a.png'));
  }
  const counts = series.map(s => `${s.id} ${s.points.length}`).join(', ');
  console.log(`Wrote ${options.out}: ${series.reduce((n, s) => n + s.points.length, 0)} points (${counts}); rotor 1 chord ${chordFit.a.toFixed(3)} ${chordFit.b.toFixed(5)} r in, RMS ${chordFit.rms.toFixed(4)} in`);
}
main();
