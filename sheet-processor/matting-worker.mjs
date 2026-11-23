import { parentPort } from 'node:worker_threads';
import { sotaCellMattingV5_3_Turbo } from './v53-matting.mjs';

if (parentPort) {
  parentPort.on('message', (msg) => {
    const { jobId, buffer, cw, ch, qualityEnhancements, gutter = 3 } = msg;
    const rgba = new Uint8ClampedArray(buffer);
    const t0 = performance.now();
    sotaCellMattingV5_3_Turbo(rgba, cw, ch, {
      qualityEnhancements,
      inPlace: true,
    });
    // Apply 3px transparent protective gutter in worker too
    if (gutter > 0) {
      const data32 = new Uint32Array(rgba.buffer, rgba.byteOffset, cw * ch);
      for (let y = 0; y < ch; y++) {
        const rowOff = y * cw;
        if (y < gutter || y >= ch - gutter) {
          data32.fill(0, rowOff, rowOff + cw);
        } else {
          for (let x = 0; x < gutter; x++) {
            data32[rowOff + x] = 0;
            data32[rowOff + cw - 1 - x] = 0;
          }
        }
      }
    }
    const elapsedMs = performance.now() - t0;
    parentPort.postMessage(
      { jobId, buffer: rgba.buffer, cw, ch, elapsedMs },
      [rgba.buffer]
    );
  });
}
