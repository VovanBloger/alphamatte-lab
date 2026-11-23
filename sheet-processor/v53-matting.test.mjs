import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxFilterFast,
  boxFilter2Fast,
  manhattanDistanceTransform2Pass,
  sotaCellMattingV5_3_Turbo,
  classifySubjectSemantic,
} from './v53-matting.mjs';
import { sotaCellMattingV5_2_Fast } from './v52-matting-core.mjs';

test('manhattanDistanceTransform2Pass matches exact 4-connected L1 BFS distance', () => {
  const w = 16, h = 12;
  const dist = new Uint8Array(w * h).fill(127);
  // Seed two zero points
  dist[2 * w + 3] = 0;
  dist[9 * w + 12] = 0;
  manhattanDistanceTransform2Pass(dist, w, h, 26);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const expected = Math.min(
        26,
        Math.abs(x - 3) + Math.abs(y - 2),
        Math.abs(x - 12) + Math.abs(y - 9)
      );
      assert.equal(dist[y * w + x], expected, `mismatch at (${x},${y})`);
    }
  }
});

test('boxFilter2Fast matches two independent boxFilterFast runs within float precision', () => {
  const w = 48, h = 36, r = 3;
  const n = w * h;
  const srcA = new Float32Array(n);
  const srcB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    srcA[i] = (i * 17) % 100;
    srcB[i] = Math.sin(i * 0.1) * 50 + 50;
  }

  const refA = new Float32Array(n);
  const refB = new Float32Array(n);
  const tmp1 = new Float32Array(n);
  const col1 = new Float32Array(w);
  boxFilterFast(srcA, refA, tmp1, col1, w, h, r);
  boxFilterFast(srcB, refB, tmp1, col1, w, h, r);

  const outA = new Float32Array(n);
  const outB = new Float32Array(n);
  const tmp2 = new Float32Array(n);
  const col2 = new Float32Array(w);
  boxFilter2Fast(srcA, outA, tmp1, col1, srcB, outB, tmp2, col2, w, h, r);

  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(outA[i] - refA[i]) < 1e-4, `A mismatch at ${i}`);
    assert.ok(Math.abs(outB[i] - refB[i]) < 1e-4, `B mismatch at ${i}`);
  }
});

test('sotaCellMattingV5_3_Turbo clears neutral studio background and preserves solid subject center', () => {
  const w = 128, h = 128;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      const dx = x - 64, dy = y - 64;
      if (dx * dx + dy * dy < 28 * 28) {
        rgba[off] = 220;
        rgba[off + 1] = 125;
        rgba[off + 2] = 45;
        rgba[off + 3] = 255;
      } else {
        rgba[off] = 122;
        rgba[off + 1] = 130;
        rgba[off + 2] = 140;
        rgba[off + 3] = 255;
      }
    }
  }
  const out = sotaCellMattingV5_3_Turbo(rgba, w, h, { qualityEnhancements: true });
  assert.equal(out[(5 * w + 5) * 4 + 3], 0);
  assert.equal(out[(5 * w + 120) * 4 + 3], 0);
  assert.equal(out[(64 * w + 64) * 4 + 3], 255);
});

test('semantic classifier distinguishes human portrait vs furred animal and adapts inwardDist & edge protection in v5.2', () => {
  const w = 160, h = 200;

  // 1. Synthetic human portrait: smooth warm skin face + wide sage-gray woven shirt in lower torso
  const humanRgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      const fdx = (x - 80) / 30;
      const fdy = (y - 82) / 38;
      const inFace = fdx * fdx + fdy * fdy <= 1.0;
      const inShirt = y >= 132 && x >= 12 && x <= 148;
      if (inFace) {
        humanRgba[off] = 208;
        humanRgba[off + 1] = 152;
        humanRgba[off + 2] = 116;
        humanRgba[off + 3] = 255;
      } else if (inShirt) {
        // Sage-gray shirt very close in luminance to #7A828C with subtle woven fabric grain
        const weave = ((x ^ y) & 1) ? 4 : -4;
        humanRgba[off] = 116 + weave;
        humanRgba[off + 1] = 127 + weave;
        humanRgba[off + 2] = 120 + weave;
        humanRgba[off + 3] = 255;
      } else {
        humanRgba[off] = 122;
        humanRgba[off + 1] = 130;
        humanRgba[off + 2] = 140;
        humanRgba[off + 3] = 255;
      }
    }
  }
  const humanDiag = {};
  const humanOutV52 = sotaCellMattingV5_2_Fast(humanRgba, w, h, { diagnostics: humanDiag });
  assert.equal(humanDiag.semantic.subjectType, 'human');
  assert.equal(humanDiag.semantic.params.clothOverexposureGuard, true);
  assert.ok(humanDiag.semantic.params.inwardFloodCap <= 36);
  assert.ok(humanDiag.semantic.params.edgeProtectRadius >= 6);
  // Shirt shoulder & body must stay solid opaque without erosion
  assert.equal(humanOutV52[(160 * w + 32) * 4 + 3], 255);
  assert.equal(humanOutV52[(160 * w + 128) * 4 + 3], 255);
  // Background corner must be transparent
  assert.equal(humanOutV52[(6 * w + 6) * 4 + 3], 0);

  // 2. Synthetic furred animal: high-frequency striped fur across face & compact body
  const animalRgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      const dx = (x - 80) / 42;
      const dy = (y - 105) / 56;
      if (dx * dx + dy * dy <= 1.0) {
        const fur = ((x * 3 + y * 5) & 3) === 0 ? 55 : -45;
        animalRgba[off] = Math.max(10, Math.min(245, 165 + fur));
        animalRgba[off + 1] = Math.max(10, Math.min(245, 125 + fur));
        animalRgba[off + 2] = Math.max(10, Math.min(245, 85 + fur));
        animalRgba[off + 3] = 255;
      } else {
        animalRgba[off] = 122;
        animalRgba[off + 1] = 130;
        animalRgba[off + 2] = 140;
        animalRgba[off + 3] = 255;
      }
    }
  }
  const animalDiag = {};
  sotaCellMattingV5_2_Fast(animalRgba, w, h, { diagnostics: animalDiag });
  assert.equal(animalDiag.semantic.subjectType, 'animal');
  assert.equal(animalDiag.semantic.params.clothOverexposureGuard, false);
  assert.ok(animalDiag.semantic.params.inwardFloodCap >= 50);
  assert.ok(animalDiag.semantic.params.furCaptureDepth >= 10);
  assert.equal(typeof classifySubjectSemantic, 'function');
});

test('Stage 6C Texture Recovery extracts local dark-curl patches and restores variance in flat dark shadow pockets', () => {
  const w = 160, h = 160;
  const rgba = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      const dx = x - 80, dy = y - 80;
      const rSq = dx * dx + dy * dy;
      if (rSq <= 48 * 48) {
        // Left half of dark curls: crisp high-frequency dark curl strands (patch donor zone)
        // Right pocket (x in [86..106], y in [70..90]): flattened dark shadow pocket (loss zone)
        const inFlatShadow = x >= 86 && x <= 106 && y >= 70 && y <= 90;
        if (inFlatShadow) {
          rgba[off] = 22;
          rgba[off + 1] = 22;
          rgba[off + 2] = 24;
          rgba[off + 3] = 255;
        } else {
          // Deterministic crisp dark curl pattern (luminance 12..58)
          const hash = (((x * 374761393 + y * 668265263) ^ (x * 1274126177)) >>> 24) & 31;
          const v = 14 + hash + (((x + y) & 1) ? 10 : -4);
          rgba[off] = v;
          rgba[off + 1] = v;
          rgba[off + 2] = v + 2;
          rgba[off + 3] = 255;
        }
      } else {
        rgba[off] = 122;
        rgba[off + 1] = 130;
        rgba[off + 2] = 140;
        rgba[off + 3] = 255;
      }
    }
  }

  const diagOff = {};
  const outNoRec = sotaCellMattingV5_3_Turbo(rgba, w, h, {
    qualityEnhancements: true,
    textureRecovery: false,
    diagnostics: diagOff,
  });

  const diagOn = {};
  const outWithRec = sotaCellMattingV5_3_Turbo(rgba, w, h, {
    qualityEnhancements: true,
    textureRecovery: true,
    diagnostics: diagOn,
  });

  assert.equal(diagOff.textureRecovery.recoveredPixels, 0);
  assert.ok(diagOn.textureRecovery.extractedPatches >= 4, `expected >=4 extracted patches, got ${diagOn.textureRecovery.extractedPatches}`);
  assert.ok(diagOn.textureRecovery.recoveredPixels > 50, `expected >50 recovered shadow pixels, got ${diagOn.textureRecovery.recoveredPixels}`);

  // Compute luminance std-dev inside the previously flat shadow pocket
  const shadowStd = (buf) => {
    const vals = [];
    for (let y = 74; y <= 86; y++) {
      for (let x = 90; x <= 102; x++) {
        const off = (y * w + x) * 4;
        vals.push(0.299 * buf[off] + 0.587 * buf[off + 1] + 0.114 * buf[off + 2]);
      }
    }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const varSum = vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length;
    return { mean, std: Math.sqrt(varSum) };
  };

  const before = shadowStd(outNoRec);
  const after = shadowStd(outWithRec);
  assert.ok(after.std > before.std + 1.5, `expected Stage 6C to restore shadow detail std (${before.std.toFixed(2)} -> ${after.std.toFixed(2)})`);
  // Must keep dark shadow genuinely dark (never turn it into bright gray)
  assert.ok(after.mean < 45, `expected dark curl shadow to stay dark, got mean luma ${after.mean.toFixed(1)}`);
});

test('Stage 7B Despeckle sweeps floating background dust while keeping detached bright orbs and smooth fur edges', () => {
  const w = 160, h = 160;
  const rgba = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      const dx = x - 80, dy = y - 80;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= 38) {
        // Warm orange cat core with soft linear transition over r in [32..38]
        const t = dist <= 32 ? 1.0 : Math.max(0, (38 - dist) / 6);
        rgba[off] = Math.round(115 + (225 - 115) * t);
        rgba[off + 1] = Math.round(120 + (155 - 120) * t);
        rgba[off + 2] = Math.round(132 + (92 - 132) * t);
        rgba[off + 3] = 255;
      } else {
        // Cool studio backdrop with slight center-bright lighting vignette
        const vig = Math.max(0, 1 - dist / 90) * 8;
        rgba[off] = Math.round(115 + vig);
        rgba[off + 1] = Math.round(120 + vig);
        rgba[off + 2] = Math.round(132 + vig);
        rgba[off + 3] = 255;
      }
    }
  }

  // Inject floating faint neutral dust specks around the perimeter (should be swept by Stage 7B)
  const dustCoords = [[22, 24], [28, 128], [134, 30], [138, 122], [18, 82], [142, 78]];
  for (const [cx, cy] of dustCoords) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const off = ((cy + dy) * w + (cx + dx)) * 4;
        rgba[off] = 148;
        rgba[off + 1] = 152;
        rgba[off + 2] = 160;
      }
    }
  }

  // Inject one genuine detached glowing cyan firefly orb (radius 4, high sat + bright core -> must be preserved!)
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      if (dx * dx + dy * dy <= 16) {
        const off = ((34 + dy) * w + (124 + dx)) * 4;
        rgba[off] = 95;
        rgba[off + 1] = 225;
        rgba[off + 2] = 255;
      }
    }
  }

  const diag = {};
  const out = sotaCellMattingV5_3_Turbo(rgba, w, h, {
    qualityEnhancements: true,
    despeckle: true,
    diagnostics: diag,
  });

  // All 6 floating neutral dust specks must be completely cleared (alpha === 0)
  for (const [cx, cy] of dustCoords) {
    const a = out[(cy * w + cx) * 4 + 3];
    assert.equal(a, 0, `expected floating dust speck at (${cx},${cy}) to be cleared, got alpha=${a}`);
  }

  // Genuine detached cyan glowing orb must survive with strong alpha
  const orbCenterAlpha = out[(34 * w + 124) * 4 + 3];
  assert.ok(orbCenterAlpha >= 180, `expected detached glowing orb to be preserved, got alpha=${orbCenterAlpha}`);

  // Outer fur transition along y=80 from x=40..50 must NOT have a crusty spike-then-dip reversal
  const outerAlpha = out[(80 * w + 42) * 4 + 3];
  const midAlpha = out[(80 * w + 45) * 4 + 3];
  const innerAlpha = out[(80 * w + 49) * 4 + 3];
  assert.ok(outerAlpha <= midAlpha + 8 && midAlpha <= innerAlpha + 8, `expected smooth monotonic fur ramp, got ${outerAlpha} -> ${midAlpha} -> ${innerAlpha}`);
});

