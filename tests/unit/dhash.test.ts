import { describe, expect, it } from 'vitest';
import { dhashFromRgba } from '@intentbridge/web-core';

function image(invert = false): Uint8ClampedArray {
  const width = 18;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = invert ? (width - x) * 12 : y * 12;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

describe('difference hash', () => {
  it('is deterministic and changes with the image', () => {
    expect(dhashFromRgba(image(), 18, 16)).toMatch(/^[0-9a-f]{16}$/);
    expect(dhashFromRgba(image(), 18, 16)).toBe(dhashFromRgba(image(), 18, 16));
    expect(dhashFromRgba(image(), 18, 16)).not.toBe(dhashFromRgba(image(true), 18, 16));
    expect(() => dhashFromRgba(new Uint8ClampedArray(4), 18, 16)).toThrow(/invalid RGBA/);
  });
});
