import sharp from 'sharp';

/**
 * Generates an SVG character sticker centered at (cx, cy) with scale s.
 * Features:
 * - Thick white die-cut sticker border
 * - Cat ears, spiky hair/fur tufts, and fine semi-transparent whiskers
 * - Bright green eyes (#00E838) and green hoodie (#00D232) INSIDE the character silhouette
 * - An enclosed background hole (arm-on-hip gap filled with bgHex and surrounded by white outline)
 * - Detached floating elements (hearts, stars, confetti) belonging to the same sticker
 * - Optional overhanging tail extending right/left
 * - Optional badge number (1..12) encoded via distinct color dots for row-major order verification
 */
export function buildCharacterSvg(cx, cy, scale, opts = {}) {
  const {
    bgHex = '#00FF00',
    eyeGreen = '#00EB3B',
    shirtGreen = '#00D434',
    furColor = '#FF8C42',
    includeEnclosedHole = true,
    includeDetachedHearts = true,
    includeWhiskers = true,
    overhangRightPx = 0,
    badgeIndex = 1,
  } = opts;

  const s = scale;
  // Distinct RGB marker color per sticker index (1..12) on the chest badge so tests can verify row-major ordering
  const badgeR = (badgeIndex * 19) % 200 + 40;
  const badgeG = (badgeIndex * 43) % 180 + 30;
  const badgeB = (badgeIndex * 71) % 200 + 45;
  const badgeColor = `rgb(${badgeR},${badgeG},${badgeB})`;

  const parts = [];

  // 1. Detached floating elements (hearts, sparkles, confetti) in the same cell
  if (includeDetachedHearts) {
    const hx = cx - 95 * s;
    const hy = cy - 102 * s;
    parts.push(`
      <g transform="translate(${hx}, ${hy}) scale(${s})">
        <path d="M0,12 C-12,-4 -26,6 -14,22 L0,36 L14,22 C26,6 12,-4 0,12 Z"
          fill="#FF3B6B" stroke="#FFFFFF" stroke-width="8" stroke-linejoin="round" />
      </g>
    `);
    const sx = cx + 98 * s;
    const sy = cy - 96 * s;
    parts.push(`
      <g transform="translate(${sx}, ${sy}) scale(${s})">
        <polygon points="0,-18 5,-5 18,0 5,5 0,18 -5,5 -18,0 -5,-5"
          fill="#FFD166" stroke="#FFFFFF" stroke-width="7" stroke-linejoin="round" />
      </g>
    `);
  }

  // 2. Optional overhanging tail (for testing non-rigid seam shifting & non-clipping)
  if (overhangRightPx > 0) {
    const tx = cx + 70 * s;
    const ty = cy + 45 * s;
    parts.push(`
      <path d="M ${tx} ${ty} Q ${tx + overhangRightPx * 0.65} ${ty - 32 * s}, ${tx + overhangRightPx} ${ty - 8 * s}"
        fill="none" stroke="#FFFFFF" stroke-width="${28 * s}" stroke-linecap="round" />
      <path d="M ${tx} ${ty} Q ${tx + overhangRightPx * 0.65} ${ty - 32 * s}, ${tx + overhangRightPx} ${ty - 8 * s}"
        fill="none" stroke="${furColor}" stroke-width="${16 * s}" stroke-linecap="round" />
    `);
  }

  // 3. Fine cat whiskers & fur strands extending slightly outside the head outline
  if (includeWhiskers) {
    parts.push(`
      <g stroke="#FFFFFF" stroke-linecap="round" opacity="0.96">
        <line x1="${cx - 58 * s}" y1="${cy - 18 * s}" x2="${cx - 116 * s}" y2="${cy - 28 * s}" stroke-width="${3.2 * s}" />
        <line x1="${cx - 58 * s}" y1="${cy - 8 * s}"  x2="${cx - 118 * s}" y2="${cy - 8 * s}"  stroke-width="${2.8 * s}" />
        <line x1="${cx - 58 * s}" y1="${cy + 2 * s}"  x2="${cx - 114 * s}" y2="${cy + 14 * s}" stroke-width="${2.4 * s}" />
        <line x1="${cx + 58 * s}" y1="${cy - 18 * s}" x2="${cx + 116 * s}" y2="${cy - 28 * s}" stroke-width="${3.2 * s}" />
        <line x1="${cx + 58 * s}" y1="${cy - 8 * s}"  x2="${cx + 118 * s}" y2="${cy - 8 * s}"  stroke-width="${2.8 * s}" />
        <line x1="${cx + 58 * s}" y1="${cy + 2 * s}"  x2="${cx + 114 * s}" y2="${cy + 14 * s}" stroke-width="${2.4 * s}" />
      </g>
    `);
  }

  // 4. White die-cut outer sticker silhouette (head + ears + torso + left arm loop)
  parts.push(`
    <g>
      <!-- Outer white die-cut border -->
      <polygon points="${cx - 58 * s},${cy - 55 * s} ${cx - 72 * s},${cy - 122 * s} ${cx - 18 * s},${cy - 82 * s}"
        fill="${furColor}" stroke="#FFFFFF" stroke-width="${18 * s}" stroke-linejoin="round" />
      <polygon points="${cx + 58 * s},${cy - 55 * s} ${cx + 72 * s},${cy - 122 * s} ${cx + 18 * s},${cy - 82 * s}"
        fill="${furColor}" stroke="#FFFFFF" stroke-width="${18 * s}" stroke-linejoin="round" />
      <!-- Spiky top fur tuft -->
      <path d="M ${cx - 18 * s} ${cy - 84 * s} L ${cx - 6 * s} ${cy - 112 * s} L ${cx + 4 * s} ${cy - 90 * s} L ${cx + 16 * s} ${cy - 110 * s} L ${cx + 20 * s} ${cy - 82 * s} Z"
        fill="${furColor}" stroke="#FFFFFF" stroke-width="${12 * s}" stroke-linejoin="round" />

      <!-- Torso / Hoodie outer white border -->
      <rect x="${cx - 64 * s}" y="${cy + 18 * s}" width="${128 * s}" height="${96 * s}" rx="${34 * s}"
        fill="#FFFFFF" stroke="#FFFFFF" stroke-width="${18 * s}" />

      <!-- Left bent arm forming an enclosed loop with the torso -->
      <path d="M ${cx - 58 * s} ${cy + 34 * s} C ${cx - 118 * s} ${cy + 40 * s}, ${cx - 118 * s} ${cy + 94 * s}, ${cx - 58 * s} ${cy + 98 * s}"
        fill="none" stroke="#FFFFFF" stroke-width="${34 * s}" stroke-linecap="round" />
      <path d="M ${cx - 58 * s} ${cy + 34 * s} C ${cx - 118 * s} ${cy + 40 * s}, ${cx - 118 * s} ${cy + 94 * s}, ${cx - 58 * s} ${cy + 98 * s}"
        fill="none" stroke="#1E293B" stroke-width="${18 * s}" stroke-linecap="round" />

      <!-- Head outer white border -->
      <circle cx="${cx}" cy="${cy - 22 * s}" r="${68 * s}" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="${18 * s}" />
    </g>
  `);

  // 5. Enclosed background hole inside the bent left arm loop (must be cleared to alpha=0!)
  if (includeEnclosedHole) {
    parts.push(`
      <ellipse cx="${cx - 78 * s}" cy="${cy + 66 * s}" rx="${15 * s}" ry="${18 * s}"
        fill="${bgHex}" stroke="#FFFFFF" stroke-width="${5 * s}" />
    `);
  }

  // 6. Interior character fills: fur head, GREEN hoodie (with shaded folds & dark outline so it is NOT flat background), and GREEN eyes
  parts.push(`
    <g>
      <!-- Torso dark outline + green hoodie with gradient/shading folds -->
      <rect x="${cx - 60 * s}" y="${cy + 22 * s}" width="${120 * s}" height="${88 * s}" rx="${30 * s}"
        fill="${shirtGreen}" stroke="#1E293B" stroke-width="${6 * s}" />
      <!-- Hoodie shading & folds (gives interior green clothing natural variance and low boundary contrast against dark outline) -->
      <path d="M ${cx - 46 * s} ${cy + 36 * s} Q ${cx} ${cy + 64 * s} ${cx + 46 * s} ${cy + 36 * s}"
        fill="none" stroke="#0B7A24" stroke-width="${8 * s}" stroke-linecap="round" />
      <ellipse cx="${cx}" cy="${cy + 66 * s}" rx="${38 * s}" ry="${26 * s}" fill="#12B83C" opacity="0.65" />

      <!-- Chest index badge (for deterministic row-major order check) -->
      <circle cx="${cx}" cy="${cy + 70 * s}" r="${18 * s}" fill="${badgeColor}" stroke="#1E293B" stroke-width="${4 * s}" />

      <!-- Head fill -->
      <circle cx="${cx}" cy="${cy - 22 * s}" r="${64 * s}" fill="${furColor}" stroke="#1E293B" stroke-width="${6 * s}" />
      <!-- Cheeks -->
      <ellipse cx="${cx - 38 * s}" cy="${cy - 6 * s}" rx="${12 * s}" ry="${7 * s}" fill="#FF5D8F" opacity="0.65" />
      <ellipse cx="${cx + 38 * s}" cy="${cy - 6 * s}" rx="${12 * s}" ry="${7 * s}" fill="#FF5D8F" opacity="0.65" />

      <!-- Green Eyes (Critically important: must NOT be deleted by chroma key!) -->
      <circle cx="${cx - 24 * s}" cy="${cy - 26 * s}" r="${15 * s}" fill="#FFFFFF" stroke="#1E293B" stroke-width="${4.5 * s}" />
      <circle cx="${cx - 24 * s}" cy="${cy - 26 * s}" r="${10.5 * s}" fill="${eyeGreen}" />
      <circle cx="${cx - 24 * s}" cy="${cy - 26 * s}" r="${5 * s}" fill="#0F172A" />
      <circle cx="${cx - 27 * s}" cy="${cy - 30 * s}" r="${3.2 * s}" fill="#FFFFFF" />

      <circle cx="${cx + 24 * s}" cy="${cy - 26 * s}" r="${15 * s}" fill="#FFFFFF" stroke="#1E293B" stroke-width="${4.5 * s}" />
      <circle cx="${cx + 24 * s}" cy="${cy - 26 * s}" r="${10.5 * s}" fill="${eyeGreen}" />
      <circle cx="${cx + 24 * s}" cy="${cy - 26 * s}" r="${5 * s}" fill="#0F172A" />
      <circle cx="${cx + 21 * s}" cy="${cy - 30 * s}" r="${3.2 * s}" fill="#FFFFFF" />

      <!-- Nose & Smile -->
      <polygon points="${cx - 6 * s},${cy - 10 * s} ${cx + 6 * s},${cy - 10 * s} ${cx},${cy - 3 * s}" fill="#1E293B" />
      <path d="M ${cx - 14 * s} ${cy + 2 * s} Q ${cx} ${cy + 14 * s} ${cx + 14 * s} ${cy + 2 * s}"
        fill="none" stroke="#1E293B" stroke-width="${4.5 * s}" stroke-linecap="round" />
    </g>
  `);

  return parts.join('\n');
}

/**
 * Generates a full sticker sheet buffer (PNG, JPEG, or WebP) for testing and benchmarking.
 */
export async function generateTestStickerSheet(options = {}) {
  const {
    width = 1536,
    height = 1536,
    layout = '3x3',
    bgHex = '#00FF00',
    transparentBg = false,
    format = 'png',
    jpegQuality = 82,
    cellShifts = {},
    emptyCells = [],
    overhangCellIndex = null,
    overhangRightPx = 0,
    overlapCells = null, // e.g. [1, 2] bridges cell 1 and cell 2
    gradientNoise = false,
  } = options;

  const [cols, rows] = layout === '3x4' ? [3, 4] : [3, 3];
  const cellW = width / cols;
  const cellH = height / rows;
  const scale = Math.min(cellW, cellH) / 340;

  const svgElements = [];

  if (!transparentBg) {
    if (gradientNoise && bgHex.toUpperCase() === '#00FF00') {
      // Simulate uneven Gemini lighting across the chroma sheet (#04F608 to #00E804)
      svgElements.push(`
        <defs>
          <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#06FC06" />
            <stop offset="50%" stop-color="#00F204" />
            <stop offset="100%" stop-color="#04E60A" />
          </linearGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#bgGrad)" />
      `);
    } else {
      svgElements.push(`<rect width="${width}" height="${height}" fill="${bgHex}" />`);
    }
  }

  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      idx++;
      if (emptyCells.includes(idx)) continue;

      const shift = cellShifts[idx] || { dx: 0, dy: 0 };
      const cx = (c + 0.5) * cellW + shift.dx;
      const cy = (r + 0.5) * cellH + shift.dy;

      svgElements.push(
        buildCharacterSvg(cx, cy, scale, {
          bgHex: transparentBg ? 'none' : bgHex,
          includeEnclosedHole: !transparentBg,
          overhangRightPx: overhangCellIndex === idx ? overhangRightPx : 0,
          badgeIndex: idx,
        }),
      );
    }
  }

  // Optional overlapping bridge between two horizontally adjacent cells (e.g. cell 1 and cell 2)
  if (overlapCells && overlapCells.length === 2) {
    const c1 = overlapCells[0] - 1;
    const r = Math.floor(c1 / cols);
    const c = c1 % cols;
    const x1 = (c + 0.5) * cellW;
    const x2 = (c + 1.5) * cellW;
    const y = (r + 0.5) * cellH;
    svgElements.push(`
      <path d="M ${x1} ${y + 20 * scale} L ${x2} ${y + 20 * scale}"
        stroke="#FFFFFF" stroke-width="${42 * scale}" stroke-linecap="round" />
      <path d="M ${x1} ${y + 20 * scale} L ${x2} ${y + 20 * scale}"
        stroke="#FF8C42" stroke-width="${26 * scale}" stroke-linecap="round" />
    `);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${svgElements.join('\n')}
  </svg>`;

  let pipeline = sharp(Buffer.from(svg));
  if (format === 'jpeg' || format === 'jpg') {
    pipeline = pipeline.jpeg({ quality: jpegQuality, chromaSubsampling: '4:2:0' });
  } else if (format === 'webp') {
    pipeline = pipeline.webp({ quality: jpegQuality });
  } else {
    pipeline = pipeline.png({ compressionLevel: 6 });
  }

  return pipeline.toBuffer();
}

/**
 * Helper to composite a transparent RGBA sticker PNG onto a solid background color
 * and measure edge halo / background spill.
 */
export async function compositeStickerOnSolid(pngPathOrBuffer, rgb = { r: 255, g: 255, b: 255 }) {
  const { data, info } = await sharp(pngPathOrBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.allocUnsafe(info.width * info.height * 3);
  let pureGreenHaloPixels = 0;
  let semiTransparentEdgePixels = 0;

  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3] / 255;

    const compR = Math.round(r * a + rgb.r * (1 - a));
    const compG = Math.round(g * a + rgb.g * (1 - a));
    const compB = Math.round(b * a + rgb.b * (1 - a));

    out[j] = compR;
    out[j + 1] = compG;
    out[j + 2] = compB;

    if (data[i + 3] > 15 && data[i + 3] < 240) {
      semiTransparentEdgePixels++;
      // Check if an edge pixel still has neon green spill (g >> r and g >> b)
      if (g - Math.max(r, b) > 45) {
        pureGreenHaloPixels++;
      }
    }
  }

  const buffer = await sharp(out, {
    raw: { width: info.width, height: info.height, channels: 3 },
  })
    .png()
    .toBuffer();

  return {
    buffer,
    semiTransparentEdgePixels,
    pureGreenHaloPixels,
  };
}
