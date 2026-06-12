const fs = require('fs');
const zlib = require('zlib');

const SIZE = parseInt(process.argv[3] || '256', 10);
const W = SIZE, H = SIZE;
const s = SIZE / 256; // scale factor for the design coordinates below

const data = Buffer.alloc(W * H * 4);
const CORNER_RADIUS = 56; // unscaled design units

function lerp(a, b, t) { return a + (b - a) * t; }
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function scalePt([x, y]) { return [x * s, y * s]; }
function scalePoly(poly) { return poly.map(scalePt); }

const bg0 = hexToRgb('#0a0f1f');
const bg1 = hexToRgb('#16243f');
const glowColor = hexToRgb('#38bdf8');
const ringColor = hexToRgb('#2dd4ee');
const topA = hexToRgb('#ffffff'); // top wing: white (catches light)
const topB = hexToRgb('#dbeafe');
const botA = hexToRgb('#475569'); // bottom wing: shadowed slate
const botB = hexToRgb('#94a3b8');

// Plane "flies through" the ring: tail outside top-left, tip pierces outside right.
const TIP = [220, 128];
const TOP_BACK = [20, 40];
const BOT_BACK = [20, 216];
const NOTCH = [135, 128];

const topTri = scalePoly([TIP, TOP_BACK, NOTCH]);
const botTri = scalePoly([TIP, BOT_BACK, NOTCH]);

const SHADOW_OFFSET = 10;
const shadowQuad = scalePoly([
  [TOP_BACK[0] + SHADOW_OFFSET, TOP_BACK[1] + SHADOW_OFFSET],
  [TIP[0] + SHADOW_OFFSET, TIP[1] + SHADOW_OFFSET],
  [BOT_BACK[0] + SHADOW_OFFSET, BOT_BACK[1] + SHADOW_OFFSET],
  [NOTCH[0] + SHADOW_OFFSET, NOTCH[1] + SHADOW_OFFSET],
]);

const RING_CENTER = scalePt([128, 128]);
const RING_R = 78 * s;
const RING_W = 5 * s;

const GLOW_CENTER = scalePt([190, 128]);
const GLOW_R = 110 * s;

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function gradientColor(x, y, p0, p1, c0, c1) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const len2 = dx * dx + dy * dy;
  let t = ((x - p0[0]) * dx + (y - p0[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const px = x + 0.5, py = y + 0.5;

    // Background diagonal gradient
    let t = (x + y) / (2 * (W - 1));
    let r = lerp(bg0[0], bg1[0], t);
    let g = lerp(bg0[1], bg1[1], t);
    let b = lerp(bg0[2], bg1[2], t);

    // Glow near where the plane exits the ring
    const gdx = px - GLOW_CENTER[0], gdy = py - GLOW_CENTER[1];
    const gdist = Math.sqrt(gdx * gdx + gdy * gdy);
    if (gdist < GLOW_R) {
      const alpha = 0.3 * (1 - gdist / GLOW_R);
      r = lerp(r, glowColor[0], alpha);
      g = lerp(g, glowColor[1], alpha);
      b = lerp(b, glowColor[2], alpha);
    }

    // Orbit ring
    const rdx = px - RING_CENTER[0], rdy = py - RING_CENTER[1];
    const rdist = Math.sqrt(rdx * rdx + rdy * rdy);
    if (rdist > RING_R - RING_W / 2 && rdist < RING_R + RING_W / 2) {
      const alpha = 0.35;
      r = lerp(r, ringColor[0], alpha);
      g = lerp(g, ringColor[1], alpha);
      b = lerp(b, ringColor[2], alpha);
    }

    // Drop shadow
    if (pointInPolygon(px, py, shadowQuad)) {
      const alpha = 0.35;
      r = lerp(r, 0, alpha);
      g = lerp(g, 0, alpha);
      b = lerp(b, 0, alpha);
    }

    // Bottom wing (darker, shadowed underside)
    if (pointInPolygon(px, py, botTri)) {
      [r, g, b] = gradientColor(px, py, scalePt(BOT_BACK), scalePt(TIP), botA, botB);
    }

    // Top wing (lighter, catches light) — drawn last so it wins on the shared edge
    if (pointInPolygon(px, py, topTri)) {
      [r, g, b] = gradientColor(px, py, scalePt(TOP_BACK), scalePt(TIP), topA, topB);
    }

    // Rounded-rect mask with 1px anti-aliased edge
    const cr = CORNER_RADIUS * s;
    const qx = Math.max(Math.abs(px - W / 2) - (W / 2 - cr), 0);
    const qy = Math.max(Math.abs(py - H / 2) - (H / 2 - cr), 0);
    const dist = Math.sqrt(qx * qx + qy * qy) - cr;
    const alpha = Math.max(0, Math.min(1, 0.5 - dist));

    const idx = (y * W + x) * 4;
    data[idx] = Math.round(r);
    data[idx + 1] = Math.round(g);
    data[idx + 2] = Math.round(b);
    data[idx + 3] = Math.round(alpha * 255);
  }
}

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, chunkData) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(chunkData.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, chunkData])), 0);
  return Buffer.concat([len, typeBuf, chunkData, crcBuf]);
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4);
  raw[rowStart] = 0;
  data.copy(raw, rowStart + 1, y * W * 4, (y + 1) * W * 4);
}

const idatData = zlib.deflateSync(raw);

const png = Buffer.concat([
  signature,
  chunk('IHDR', ihdr),
  chunk('IDAT', idatData),
  chunk('IEND', Buffer.alloc(0))
]);

const outFile = process.argv[2] || 'icon-preview.png';
fs.writeFileSync(outFile, png);
console.log('written', outFile, png.length, 'bytes');
