/* =========================================================
   Indexed Image Creator — script.js
   All image processing happens entirely in the browser.
   ========================================================= */
'use strict';

// ========== Application State ==========

// Default conversion settings shared across images
const DEFAULT_SETTINGS = {
  paletteType:    'optimal',
  numColors:      256,
  colorDithering: 'floyd-steinberg',
  alphaDithering: 'floyd-steinberg',
  removeUnused:   true,
};

// Each entry: { originalImageData, originalWidth, originalHeight,
//               originalFileName, originalFileSize, originalFileType,
//               hasAlpha, currentPalette, currentIndices, transparentIdx,
//               settings: { paletteType, numColors, colorDithering, alphaDithering, removeUnused } }
const imageList      = [];    // array of per-image state objects
let   activeIdx      = 0;     // index of the currently displayed image
let   linkedSettings = true;  // true = all images share the same settings

function getActiveImage() {
  return imageList[activeIdx] || null;
}

// ========== Colour Utilities ==========

/** Squared Euclidean distance between two RGB colours (no sqrt needed for comparisons). */
function colorDistSq(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/** Return the index of the palette entry closest to (r, g, b). */
function findNearest(r, g, b, palette) {
  let best = 0;
  let minDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = colorDistSq(r, g, b, palette[i][0], palette[i][1], palette[i][2]);
    if (d < minDist) {
      minDist = d;
      best = i;
      if (d === 0) break;
    }
  }
  return best;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Convert an [r, g, b] array to a CSS hex string like "#1a2b3c". */
function rgbToHex(r, g, b) {
  return '#' + r.toString(16).padStart(2, '0')
             + g.toString(16).padStart(2, '0')
             + b.toString(16).padStart(2, '0');
}

// ========== Palette Generation ==========

/**
 * Sample up to `maxSamples` opaque pixels from ImageData.
 * Returns an array of [r, g, b] tuples.
 */
function samplePixels(data, width, height, maxSamples) {
  const total = width * height;
  const pixels = [];
  const step = Math.max(1, Math.floor(total / maxSamples));

  for (let i = 0; i < total; i += step) {
    const idx = i * 4;
    if (data[idx + 3] >= 128) {
      pixels.push([data[idx], data[idx + 1], data[idx + 2]]);
    }
  }
  return pixels;
}

/**
 * Median-Cut colour quantisation.
 * Splits the colour space recursively until `numColors` buckets exist,
 * then averages each bucket to produce a palette entry.
 */
function medianCut(pixels, numColors) {
  if (pixels.length === 0) return [[0, 0, 0]];

  let boxes = [pixels.slice()];

  while (boxes.length < numColors) {
    // Find the box with the largest range along any channel
    let maxRange = -1;
    let splitIdx = 0;
    let splitChannel = 0;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;

      let minR = 255, maxR = 0;
      let minG = 255, maxG = 0;
      let minB = 255, maxB = 0;

      for (const p of box) {
        if (p[0] < minR) minR = p[0]; if (p[0] > maxR) maxR = p[0];
        if (p[1] < minG) minG = p[1]; if (p[1] > maxG) maxG = p[1];
        if (p[2] < minB) minB = p[2]; if (p[2] > maxB) maxB = p[2];
      }

      const rR = maxR - minR;
      const rG = maxG - minG;
      const rB = maxB - minB;
      const range = Math.max(rR, rG, rB);

      if (range > maxRange) {
        maxRange = range;
        splitIdx = i;
        splitChannel = (rR >= rG && rR >= rB) ? 0 : (rG >= rB) ? 1 : 2;
      }
    }

    if (maxRange === 0) break; // All remaining boxes are single-colour

    const box = boxes[splitIdx];
    const ch = splitChannel;
    box.sort((a, b) => a[ch] - b[ch]);

    const mid = Math.ceil(box.length / 2);
    boxes.splice(splitIdx, 1, box.slice(0, mid), box.slice(mid));
  }

  // Average each box to produce a palette colour
  return boxes
    .filter(box => box.length > 0)
    .map(box => {
      let r = 0, g = 0, b = 0;
      for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
      const n = box.length;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
}

/** Generate the 216-colour web-safe palette (6×6×6 colour cube). */
function getWebPalette() {
  const palette = [];
  for (let r = 0; r <= 5; r++) {
    for (let g = 0; g <= 5; g++) {
      for (let b = 0; b <= 5; b++) {
        palette.push([r * 51, g * 51, b * 51]);
      }
    }
  }
  return palette; // 216 entries
}

/** 1-bit black-and-white palette. */
function getBWPalette() {
  return [[0, 0, 0], [255, 255, 255]];
}

/**
 * Build a palette from imageData according to `paletteType` and `numColors`.
 * Returns an array of up to `numColors` [r, g, b] tuples.
 */
function buildPalette(imageData, paletteType, numColors) {
  const { data, width, height } = imageData;

  switch (paletteType) {
    case 'web':
      return getWebPalette();
    case 'bw':
      return getBWPalette();
    default: { // 'optimal'
      const pixels = samplePixels(data, width, height, 150000);
      if (pixels.length === 0) return [[0, 0, 0]];
      return medianCut(pixels, numColors);
    }
  }
}

// ========== Dithering ==========

/**
 * Bayer 8×8 threshold matrix (values 0–63, normalised by dividing by 64).
 * Used for ordered / fixed dithering.
 */
const BAYER_8x8 = new Uint8Array([
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]);

/**
 * Quantise imageData against `palette` using the chosen dithering algorithm.
 *
 * @param {ImageData} imageData
 * @param {Array}     palette          Array of [r, g, b]
 * @param {string}    colorDithering   'none'|'floyd-steinberg'|'floyd-steinberg-reduced'|'fixed'
 * @param {string}    alphaDithering   'none'|'floyd-steinberg'|'floyd-steinberg-reduced'|'fixed'
 * @param {boolean}   hasAlpha         Whether the source image has meaningful alpha
 * @param {number|null} transparentIdx  Palette index reserved for transparent pixels
 * @returns {Uint8Array}  One palette index per pixel
 */
function quantise(imageData, palette, colorDithering, alphaDithering, hasAlpha, transparentIdx) {
  const { data, width, height } = imageData;
  const n = width * height;
  const indices = new Uint8Array(n);

  // Working buffers (float) for error diffusion
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const A = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    R[i] = data[i * 4];
    G[i] = data[i * 4 + 1];
    B[i] = data[i * 4 + 2];
    A[i] = data[i * 4 + 3];
  }

  if (colorDithering === 'none') {
    // ---- No dithering ----
    for (let i = 0; i < n; i++) {
      if (hasAlpha && A[i] < 128) {
        indices[i] = transparentIdx !== null ? transparentIdx : 0;
      } else {
        indices[i] = findNearest(
          clamp(Math.round(R[i]), 0, 255),
          clamp(Math.round(G[i]), 0, 255),
          clamp(Math.round(B[i]), 0, 255),
          palette
        );
      }
    }

  } else if (colorDithering === 'floyd-steinberg' || colorDithering === 'floyd-steinberg-reduced') {
    // ---- Floyd-Steinberg error diffusion ----
    // 'reduced' uses half the diffusion weight to reduce colour bleeding
    const factor = colorDithering === 'floyd-steinberg-reduced' ? 0.5 : 1.0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;

        if (hasAlpha && A[i] < 128) {
          indices[i] = transparentIdx !== null ? transparentIdx : 0;
          continue;
        }

        const oldR = clamp(Math.round(R[i]), 0, 255);
        const oldG = clamp(Math.round(G[i]), 0, 255);
        const oldB = clamp(Math.round(B[i]), 0, 255);

        const palIdx = findNearest(oldR, oldG, oldB, palette);
        indices[i] = palIdx;

        const eR = (oldR - palette[palIdx][0]) * factor;
        const eG = (oldG - palette[palIdx][1]) * factor;
        const eB = (oldB - palette[palIdx][2]) * factor;

        // Diffuse error to 4 neighbours (Floyd-Steinberg weights):
        //    . * 7  (right)
        //  3 5 1    (below-left, below, below-right)  — divided by 16
        if (x + 1 < width) {
          R[i + 1] += eR * 7 / 16;
          G[i + 1] += eG * 7 / 16;
          B[i + 1] += eB * 7 / 16;
        }
        if (y + 1 < height) {
          if (x > 0) {
            R[i + width - 1] += eR * 3 / 16;
            G[i + width - 1] += eG * 3 / 16;
            B[i + width - 1] += eB * 3 / 16;
          }
          R[i + width] += eR * 5 / 16;
          G[i + width] += eG * 5 / 16;
          B[i + width] += eB * 5 / 16;
          if (x + 1 < width) {
            R[i + width + 1] += eR * 1 / 16;
            G[i + width + 1] += eG * 1 / 16;
            B[i + width + 1] += eB * 1 / 16;
          }
        }
      }
    }

  } else if (colorDithering === 'fixed') {
    // ---- Bayer ordered (fixed) dithering ----
    // The threshold perturbs the pixel value before nearest-colour lookup.
    const spread = 24; // amplitude of the perturbation (roughly 1/2 colour step for 256 colours)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;

        if (hasAlpha && A[i] < 128) {
          indices[i] = transparentIdx !== null ? transparentIdx : 0;
          continue;
        }

        const threshold = (BAYER_8x8[(y % 8) * 8 + (x % 8)] / 64 - 0.5) * spread;

        const adjR = clamp(Math.round(R[i] + threshold), 0, 255);
        const adjG = clamp(Math.round(G[i] + threshold), 0, 255);
        const adjB = clamp(Math.round(B[i] + threshold), 0, 255);

        indices[i] = findNearest(adjR, adjG, adjB, palette);
      }
    }
  }

  return indices;
}

// ========== PNG Encoding (true indexed / palette PNG) ==========

// Pre-computed CRC-32 lookup table
const CRC32 = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Adler-32 checksum (used in zlib wrapper). */
function adler32(data) {
  let s1 = 1, s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

/**
 * Wrap `data` in a valid zlib stream using uncompressed DEFLATE stored blocks
 * (BTYPE=00).  This avoids implementing a full DEFLATE compressor while still
 * producing a spec-compliant PNG IDAT payload.
 */
function zlibStore(data) {
  // zlib CMF=0x78 (deflate, 32 K window), FLG chosen so (CMF*256+FLG) % 31 === 0
  // 0x78 * 256 = 30720, 30720 % 31 = 30, so FLG must satisfy FLG % 31 = 1 → FLG = 0x01
  const BLOCK = 65535; // max payload bytes per stored block (DEFLATE RFC 1951 limit)
  const numBlocks = Math.ceil(data.length / BLOCK) || 1;
  const out = new Uint8Array(2 + numBlocks * 5 + data.length + 4);
  let pos = 0;

  out[pos++] = 0x78;  // CMF
  out[pos++] = 0x01;  // FLG

  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const end = Math.min(offset + BLOCK, data.length);
    const len = end - offset;
    const nlen = (~len) & 0xFFFF;
    const last = (end >= data.length) ? 1 : 0;

    out[pos++] = last;             // BFINAL | BTYPE=00
    out[pos++] = len & 0xFF;       // LEN low
    out[pos++] = (len >> 8) & 0xFF; // LEN high
    out[pos++] = nlen & 0xFF;      // NLEN low
    out[pos++] = (nlen >> 8) & 0xFF; // NLEN high
    out.set(data.subarray(offset, end), pos);
    pos += len;
    offset = end;
  }

  const chk = adler32(data);
  out[pos++] = (chk >>> 24) & 0xFF;
  out[pos++] = (chk >>> 16) & 0xFF;
  out[pos++] = (chk >>> 8) & 0xFF;
  out[pos++] = chk & 0xFF;

  return out;
}

/** Build and return a single PNG chunk as a Uint8Array. */
function pngChunk(type, payload) {
  const len = payload.length;
  const out = new Uint8Array(12 + len);
  // Length (big-endian u32)
  out[0] = (len >>> 24) & 0xFF;
  out[1] = (len >>> 16) & 0xFF;
  out[2] = (len >>> 8) & 0xFF;
  out[3] = len & 0xFF;
  // Type (4 ASCII bytes)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  // Payload
  out.set(payload, 8);
  // CRC over type + payload
  const crc = crc32(out.subarray(4, 8 + len));
  out[8 + len] = (crc >>> 24) & 0xFF;
  out[9 + len] = (crc >>> 16) & 0xFF;
  out[10 + len] = (crc >>> 8) & 0xFF;
  out[11 + len] = crc & 0xFF;
  return out;
}

/**
 * Encode a palette image as a PNG with colour type 3 (indexed-colour).
 *
 * @param {number}       width
 * @param {number}       height
 * @param {Array}        palette        Array of [r, g, b]
 * @param {Uint8Array}   indices        One palette index per pixel
 * @param {number|null}  transparentIdx  Palette index of the transparent entry, or null
 * @returns {Uint8Array}  Raw PNG bytes
 */
function encodeIndexedPNG(width, height, palette, indices, transparentIdx) {
  const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // -- IHDR --
  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xFF; ihdr[1] = (width >>> 16) & 0xFF;
  ihdr[2] = (width >>> 8) & 0xFF;  ihdr[3] = width & 0xFF;
  ihdr[4] = (height >>> 24) & 0xFF; ihdr[5] = (height >>> 16) & 0xFF;
  ihdr[6] = (height >>> 8) & 0xFF;  ihdr[7] = height & 0xFF;
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 3;  // colour type: indexed
  // compression=0, filter=0, interlace=0 already zero-initialised

  // -- PLTE --
  const plte = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    plte[i * 3]     = palette[i][0];
    plte[i * 3 + 1] = palette[i][1];
    plte[i * 3 + 2] = palette[i][2];
  }

  // -- tRNS (optional) --
  // For an indexed PNG the tRNS chunk lists an alpha byte for each palette
  // entry up to and including the last entry that has non-opaque alpha.
  let trnsChunk = null;
  if (transparentIdx !== null) {
    const trnsLen = transparentIdx + 1;
    const trns = new Uint8Array(trnsLen); // zero-initialised → all 0x00 (transparent)
    // Mark all earlier entries as fully opaque
    for (let i = 0; i < transparentIdx; i++) trns[i] = 0xFF;
    trnsChunk = pngChunk('tRNS', trns);
  }

  // -- IDAT --
  // Raw image data: one filter byte (0 = None) followed by row pixels.
  const rowStride = 1 + width;
  const raw = new Uint8Array(height * rowStride);
  for (let y = 0; y < height; y++) {
    raw[y * rowStride] = 0; // filter byte: None
    raw.set(indices.subarray(y * width, (y + 1) * width), y * rowStride + 1);
  }

  // -- Assemble --
  const ihdrChunk = pngChunk('IHDR', ihdr);
  const plteChunk = pngChunk('PLTE', plte);
  const idatChunk = pngChunk('IDAT', zlibStore(raw));
  const iendChunk = pngChunk('IEND', new Uint8Array(0));

  const parts = [PNG_SIG, ihdrChunk, plteChunk];
  if (trnsChunk) parts.push(trnsChunk);
  parts.push(idatChunk, iendChunk);

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// ========== Rendering Helpers ==========

/**
 * Draw the indexed image (from palette + index array) onto a canvas.
 * Transparent pixels are rendered with alpha = 0.
 */
function renderIndexed(canvas, width, height, palette, indices, transparentIdx) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  const d = img.data;

  for (let i = 0; i < width * height; i++) {
    const pi = indices[i];
    const c = palette[pi] || [0, 0, 0];
    d[i * 4]     = c[0];
    d[i * 4 + 1] = c[1];
    d[i * 4 + 2] = c[2];
    d[i * 4 + 3] = (transparentIdx !== null && pi === transparentIdx) ? 0 : 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Populate the palette swatch strip below the previews. */
function renderSwatches(palette, transparentIdx) {
  const container = document.getElementById('palette-swatches');
  container.innerHTML = '';

  palette.forEach((colour, idx) => {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.setAttribute('role', 'listitem');

    if (idx === transparentIdx) {
      // Checkerboard pattern to indicate transparency
      sw.style.background =
        'repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 0 0 / 8px 8px';
      sw.title = 'Transparent';
    } else {
      const hex = rgbToHex(colour[0], colour[1], colour[2]);      sw.style.backgroundColor = hex;
      sw.title = hex.toUpperCase();
    }

    container.appendChild(sw);
  });

  document.getElementById('palette-count').textContent =
    `(${palette.length} colour${palette.length !== 1 ? 's' : ''})`;
}

// ========== Status helpers ==========

function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}

// ========== Settings Management ==========

/** Read current values from the settings panel controls. */
function readSettingsUI() {
  return {
    paletteType:    document.getElementById('palette-type').value,
    numColors:      parseInt(document.getElementById('num-colors').value, 10),
    colorDithering: document.getElementById('color-dithering').value,
    alphaDithering: document.getElementById('alpha-dithering').value,
    removeUnused:   document.getElementById('remove-unused').checked,
  };
}

/** Push a settings object into the UI controls. */
function applySettingsToUI(settings) {
  document.getElementById('palette-type').value             = settings.paletteType;
  document.getElementById('num-colors').value               = settings.numColors;
  document.getElementById('num-colors-display').textContent = settings.numColors;
  document.getElementById('color-dithering').value          = settings.colorDithering;
  document.getElementById('alpha-dithering').value          = settings.alphaDithering;
  document.getElementById('remove-unused').checked          = settings.removeUnused;
  updatePaletteTypeUI();
}

/** Called when any settings control changes — syncs back to image state(s). */
function onSettingChanged() {
  const s = readSettingsUI();
  if (linkedSettings) {
    imageList.forEach(img => { img.settings = { ...s }; });
  } else {
    const img = getActiveImage();
    if (img) img.settings = { ...s };
  }
}

// ========== Image Tab Management ==========

function truncateFilename(name, maxLen) {
  if (name.length <= maxLen) return name;
  const extIdx = name.lastIndexOf('.');
  const ext    = extIdx > 0 ? name.slice(extIdx) : '';
  return name.slice(0, maxLen - ext.length - 1) + '…' + ext;
}

function buildImageTabs() {
  const tabsEl = document.getElementById('image-tabs');
  tabsEl.innerHTML = '';
  const multi = imageList.length > 1;
  tabsEl.classList.toggle('hidden', !multi);
  document.getElementById('convert-all-btn').classList.toggle('hidden', !multi);
  const anyConverted = imageList.some(img => img.currentPalette);
  document.getElementById('download-all-btn').classList.toggle('hidden', !multi || !anyConverted);
  if (!multi) return;

  imageList.forEach((img, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'image-tab' + (i === activeIdx ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(i === activeIdx));
    tab.title = img.originalFileName;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = truncateFilename(img.originalFileName, 18);
    tab.appendChild(nameSpan);

    if (img.currentPalette) {
      const dot = document.createElement('span');
      dot.className = 'tab-done';
      dot.textContent = ' ✓';
      tab.appendChild(dot);
    }

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'tab-close';
    rmBtn.setAttribute('aria-label', 'Remove ' + img.originalFileName);
    rmBtn.textContent = '×';
    rmBtn.addEventListener('click', e => { e.stopPropagation(); removeImage(i); });
    tab.appendChild(rmBtn);

    tab.addEventListener('click', () => switchImage(i));
    tabsEl.appendChild(tab);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tab-add';
  addBtn.title = 'Add more images';
  addBtn.textContent = '＋ Add';
  addBtn.addEventListener('click', () => document.getElementById('file-input').click());
  tabsEl.appendChild(addBtn);
}

function switchImage(newIdx) {
  if (newIdx < 0 || newIdx >= imageList.length) return;
  if (!linkedSettings) {
    const prev = getActiveImage();
    if (prev) prev.settings = { ...readSettingsUI() };
  }
  activeIdx = newIdx;
  renderActiveImage();
  buildImageTabs();
}

function removeImage(idx) {
  imageList.splice(idx, 1);
  if (imageList.length === 0) {
    activeIdx = 0;
    document.getElementById('workspace').classList.add('hidden');
    updateDropZoneLabel();
    return;
  }
  if (activeIdx >= imageList.length) activeIdx = imageList.length - 1;
  renderActiveImage();
  buildImageTabs();
  updateDropZoneLabel();
}

function updateDropZoneLabel() {
  const p = document.querySelector('#drop-zone p');
  if (!p) return;
  if (imageList.length === 0) {
    p.innerHTML = 'Drag &amp; drop images here, or <label for="file-input" class="link-label">click to browse</label>';
  } else if (imageList.length === 1) {
    p.innerHTML = `<strong>${imageList[0].originalFileName}</strong> loaded — drag more images to add`;
  } else {
    p.innerHTML = `<strong>${imageList.length} images</strong> loaded — drag more to add`;
  }
}

// ========== Palette Panel ==========

function updatePalettePanel(palette, transparentIdx) {
  const section   = document.getElementById('palette-section');
  const toggleBtn = document.getElementById('palette-toggle-btn');
  const label     = document.getElementById('palette-toggle-label');

  if (!palette) {
    section.classList.remove('available', 'open');
    toggleBtn.disabled = true;
    toggleBtn.setAttribute('aria-expanded', 'false');
    label.textContent = 'Palette';
    return;
  }

  renderSwatches(palette, transparentIdx);
  label.textContent = `Palette (${palette.length})`;
  section.classList.add('available', 'open');
  toggleBtn.disabled = false;
  toggleBtn.setAttribute('aria-expanded', 'true');
}

function togglePalettePanel() {
  const section   = document.getElementById('palette-section');
  const toggleBtn = document.getElementById('palette-toggle-btn');
  if (!section.classList.contains('available')) return;
  const willOpen = !section.classList.contains('open');
  section.classList.toggle('open', willOpen);
  toggleBtn.setAttribute('aria-expanded', String(willOpen));
}

// ========== Preview Rendering ==========

function renderActiveImage() {
  const img = getActiveImage();
  if (!img) return;

  applySettingsToUI(img.settings);
  document.getElementById('alpha-dithering-group')
    .classList.toggle('hidden', !img.hasAlpha);

  // Draw original preview
  const origCanvas = document.getElementById('original-canvas');
  origCanvas.width  = img.originalWidth;
  origCanvas.height = img.originalHeight;
  origCanvas.getContext('2d').putImageData(img.originalImageData, 0, 0);

  document.getElementById('original-info').textContent =
    `${img.originalWidth}×${img.originalHeight} · ${img.originalFileType || 'image'} · ${(img.originalFileSize / 1024).toFixed(1)} KB`;

  // Draw indexed result (if available)
  const indexedCanvas = document.getElementById('indexed-canvas');
  if (img.currentPalette) {
    renderIndexed(indexedCanvas, img.originalWidth, img.originalHeight,
                  img.currentPalette, img.currentIndices, img.transparentIdx);
    document.getElementById('indexed-info').textContent =
      `${img.currentPalette.length} colour${img.currentPalette.length !== 1 ? 's' : ''} · ${img.originalWidth}×${img.originalHeight}`;
    updatePalettePanel(img.currentPalette, img.transparentIdx);
    document.getElementById('download-btn').classList.remove('hidden');
    setStatus(`Done — ${img.currentPalette.length} colour${img.currentPalette.length !== 1 ? 's' : ''}`, 'done');
  } else {
    indexedCanvas.width  = img.originalWidth;
    indexedCanvas.height = img.originalHeight;
    indexedCanvas.getContext('2d').clearRect(0, 0, img.originalWidth, img.originalHeight);
    document.getElementById('indexed-info').textContent = '';
    document.getElementById('download-btn').classList.add('hidden');
    updatePalettePanel(null, null);
    setStatus('Image loaded — click Convert to begin.', '');
  }
}

// ========== Core Conversion Pipeline ==========

/** Convert a single image state object in-place using its own settings. */
function convertSingleImage(imgState) {
  const { paletteType, numColors, colorDithering, alphaDithering, removeUnused } = imgState.settings;
  const imgData = imgState.originalImageData;
  const { originalWidth: width, originalHeight: height } = imgState;

  // 1. Build palette
  let palette = buildPalette(imgData, paletteType, numColors);

  // Clamp palette size for web palette when numColors < 216
  if (paletteType === 'web' && numColors < palette.length) {
    palette = palette.slice(0, numColors);
  }

  // 2. Reserve a transparent palette entry if the image has alpha
  let transparentIdx = null;
  if (imgState.hasAlpha) {
    transparentIdx = palette.length;
    palette = [...palette, [0, 0, 0]]; // placeholder entry
  }

  // 3. Enforce max-palette-size constraint (PNG indexed max = 256)
  if (palette.length > 256) {
    palette = palette.slice(0, 256);
    if (transparentIdx !== null && transparentIdx >= 256) {
      transparentIdx = 255;
      palette[255] = [0, 0, 0];
    }
  }

  // 4. Quantise / dither
  let indices = quantise(imgData, palette, colorDithering, alphaDithering,
                         imgState.hasAlpha, transparentIdx);

  // 5. Remove unused palette entries
  if (removeUnused) {
    const used = new Set(Array.from(indices));
    const remap = new Map();
    const newPalette = [];
    for (let i = 0; i < palette.length; i++) {
      if (used.has(i)) {
        remap.set(i, newPalette.length);
        newPalette.push(palette[i]);
      }
    }
    for (let i = 0; i < indices.length; i++) {
      indices[i] = remap.get(indices[i]) ?? 0;
    }
    if (transparentIdx !== null) {
      transparentIdx = remap.has(transparentIdx) ? remap.get(transparentIdx) : null;
    }
    palette = newPalette;
  }

  imgState.currentPalette = palette;
  imgState.currentIndices = indices;
  imgState.transparentIdx = transparentIdx;
}

function runConversion() {
  const img = getActiveImage();
  if (!img) return;

  onSettingChanged(); // sync UI settings to image state(s)

  const convertBtn    = document.getElementById('convert-btn');
  const convertAllBtn = document.getElementById('convert-all-btn');
  convertBtn.disabled = true;
  if (!convertAllBtn.classList.contains('hidden')) convertAllBtn.disabled = true;
  setStatus('Processing…', 'processing');

  setTimeout(() => {
    try {
      convertSingleImage(img);
      renderActiveImage();
      buildImageTabs();
    } catch (err) {
      console.error(err);
      setStatus('Error: ' + err.message, 'error');
    }
    convertBtn.disabled    = false;
    convertAllBtn.disabled = false;
  }, 20);
}

function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function runConversionAll() {
  if (imageList.length === 0) return;

  onSettingChanged();

  const convertBtn    = document.getElementById('convert-btn');
  const convertAllBtn = document.getElementById('convert-all-btn');
  convertBtn.disabled    = true;
  convertAllBtn.disabled = true;

  let done = 0, errors = 0;
  const total = imageList.length;

  for (let i = 0; i < total; i++) {
    setStatus(`Processing ${i + 1}/${total}…`, 'processing');
    await yieldToUI();
    try {
      convertSingleImage(imageList[i]);
      done++;
    } catch (err) {
      console.error(`Error converting ${imageList[i].originalFileName}:`, err);
      errors++;
    }
  }

  renderActiveImage();
  buildImageTabs();

  if (errors === 0) {
    setStatus(`Done — converted ${done} image${done !== 1 ? 's' : ''}`, 'done');
  } else {
    setStatus(`${done} converted, ${errors} failed`, 'error');
  }

  convertBtn.disabled    = false;
  convertAllBtn.disabled = false;
}

// ========== Download ==========

/** Stagger between successive downloads so browsers don't block them. */
const DOWNLOAD_STAGGER_MS = 150;

function downloadImageState(imgState) {
  const { currentPalette, currentIndices, originalWidth, originalHeight,
          transparentIdx, originalFileName } = imgState;
  if (!currentPalette || !currentIndices) return;

  const bytes = encodeIndexedPNG(originalWidth, originalHeight,
                                  currentPalette, currentIndices, transparentIdx);
  const blob = new Blob([bytes], { type: 'image/png' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = originalFileName.replace(/\.[^.]+$/, '') + '-indexed.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadPNG() {
  const img = getActiveImage();
  if (img) downloadImageState(img);
}

async function downloadAll() {
  const converted = imageList.filter(img => img.currentPalette);
  for (const img of converted) {
    downloadImageState(img);
    await new Promise(resolve => setTimeout(resolve, DOWNLOAD_STAGGER_MS));
  }
}

// ========== Image Loading ==========

function loadFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (files.length === 0) {
    setStatus('Please select valid image file(s).', 'error');
    return;
  }
  if (files.length < fileList.length) {
    setStatus(`Skipped ${fileList.length - files.length} non-image file(s).`, '');
  }
  files.forEach(loadSingleFile);
}

function loadSingleFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    let hasAlpha = false;
    for (let i = 3; i < imgData.data.length; i += 4) {
      if (imgData.data[i] < 255) { hasAlpha = true; break; }
    }

    // Inherit settings from first image if linked, otherwise start from defaults
    const settings = linkedSettings && imageList.length > 0
      ? { ...imageList[0].settings }
      : { ...DEFAULT_SETTINGS };

    imageList.push({
      originalImageData: imgData,
      originalWidth:     canvas.width,
      originalHeight:    canvas.height,
      originalFileName:  file.name,
      originalFileSize:  file.size,
      originalFileType:  file.type,
      hasAlpha,
      currentPalette:    null,
      currentIndices:    null,
      transparentIdx:    null,
      settings,
    });

    activeIdx = imageList.length - 1;
    document.getElementById('workspace').classList.remove('hidden');
    renderActiveImage();
    buildImageTabs();
    updateDropZoneLabel();
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('Could not load ' + file.name + '. Please try another file.', 'error');
  };

  img.src = url;
}

// ========== Settings: enable/disable num-colors slider ==========

function updatePaletteTypeUI() {
  const paletteType    = document.getElementById('palette-type').value;
  const numColorsGroup = document.getElementById('num-colors-group');
  numColorsGroup.classList.toggle('hidden', paletteType === 'bw');
}

// ========== Layout: measure header/footer for sticky/fixed positioning ==========

function updateLayoutVars() {
  const header = document.querySelector('header');
  const footer = document.querySelector('footer');
  if (header) {
    document.documentElement.style.setProperty(
      '--header-height', header.getBoundingClientRect().height + 'px');
  }
  if (footer) {
    document.documentElement.style.setProperty(
      '--footer-height', footer.getBoundingClientRect().height + 'px');
  }
}

// ========== Event Wiring ==========

document.addEventListener('DOMContentLoaded', () => {
  updateLayoutVars();
  window.addEventListener('resize', updateLayoutVars);

  const dropZone       = document.getElementById('drop-zone');
  const fileInput      = document.getElementById('file-input');
  const convertBtn     = document.getElementById('convert-btn');
  const convertAllBtn  = document.getElementById('convert-all-btn');
  const downloadBtn    = document.getElementById('download-btn');
  const downloadAllBtn = document.getElementById('download-all-btn');
  const numColors      = document.getElementById('num-colors');
  const paletteType    = document.getElementById('palette-type');
  const linkedToggle   = document.getElementById('linked-settings');
  const paletteToggle  = document.getElementById('palette-toggle-btn');
  const paletteClose   = document.getElementById('palette-close-btn');

  // --- File input ---
  // Guard prevents double-trigger: clicking the <label> already opens the dialog natively;
  // only fire fileInput.click() when the click originated outside the label.
  dropZone.addEventListener('click', e => {
    if (!e.target.closest('label')) fileInput.click();
  });
  dropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    // Capture as a plain array before resetting the input, because resetting
    // clears the FileList and would make Array.from() return an empty array.
    const files = Array.from(fileInput.files);
    fileInput.value = ''; // reset so the same files can be re-selected next time
    if (files.length > 0) loadFiles(files);
  });

  // --- Drag & drop ---
  ['dragenter', 'dragover'].forEach(evt =>
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    })
  );
  ['dragleave', 'dragend', 'drop'].forEach(evt =>
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    })
  );
  dropZone.addEventListener('drop', e => {
    loadFiles(e.dataTransfer.files);
  });

  // --- Settings controls ---
  ['palette-type', 'num-colors', 'color-dithering', 'alpha-dithering', 'remove-unused']
    .forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('change', onSettingChanged);
      el.addEventListener('input',  onSettingChanged);
    });

  // --- Num-colors slider label ---
  numColors.addEventListener('input', () => {
    document.getElementById('num-colors-display').textContent = numColors.value;
  });

  // --- Palette-type changes ---
  paletteType.addEventListener('change', updatePaletteTypeUI);
  updatePaletteTypeUI();

  // --- Linked settings toggle ---
  linkedToggle.addEventListener('change', () => {
    linkedSettings = linkedToggle.checked;
    if (linkedSettings && imageList.length > 0) {
      // Sync all images to the current UI settings
      const s = readSettingsUI();
      imageList.forEach(img => { img.settings = { ...s }; });
    }
  });

  // --- Convert ---
  convertBtn.addEventListener('click', runConversion);
  convertAllBtn.addEventListener('click', runConversionAll);

  // --- Download ---
  downloadBtn.addEventListener('click', downloadPNG);
  downloadAllBtn.addEventListener('click', downloadAll);

  // --- Palette panel toggle ---
  paletteToggle.addEventListener('click', togglePalettePanel);
  paletteClose.addEventListener('click', togglePalettePanel);
});
