/**
 * Difference hash (dHash) over an RGBA image. Pure and dependency-free so the
 * same implementation runs in Node (PNG decode in the runner) and in a browser
 * (canvas / OffscreenCanvas).
 */
export function dhashFromRgba(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): string {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    throw new Error('invalid RGBA buffer');
  }
  const targetW = 9;
  const targetH = 8;
  const gray = new Float64Array(targetW * targetH);
  for (let y = 0; y < targetH; y += 1) {
    const y0 = Math.floor((y * height) / targetH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / targetH));
    for (let x = 0; x < targetW; x += 1) {
      const x0 = Math.floor((x * width) / targetW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / targetW));
      let sum = 0;
      let count = 0;
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) {
          const offset = (py * width + px) * 4;
          const r = data[offset] ?? 0;
          const g = data[offset + 1] ?? 0;
          const b = data[offset + 2] ?? 0;
          const a = (data[offset + 3] ?? 255) / 255;
          sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) * a;
          count += 1;
        }
      }
      gray[y * targetW + x] = count > 0 ? sum / count : 0;
    }
  }
  let bits = 0n;
  let index = 0n;
  for (let y = 0; y < targetH; y += 1) {
    for (let x = 0; x < targetW - 1; x += 1) {
      const left = gray[y * targetW + x] as number;
      const right = gray[y * targetW + x + 1] as number;
      if (left > right) bits |= 1n << index;
      index += 1n;
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/** Hamming similarity in [0, 1], symmetric and safe for malformed hashes. */
export function dhashSimilarity(left: string, right: string): number {
  if (!left || !right || left.length !== right.length) return 0;
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return 0;
  let differing = 0;
  let total = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = Number.parseInt(left[i] as string, 16);
    const b = Number.parseInt(right[i] as string, 16);
    differing += (a ^ b).toString(2).replace(/0/g, '').length;
    total += 4;
  }
  return 1 - differing / total;
}
