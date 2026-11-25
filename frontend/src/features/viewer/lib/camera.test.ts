import { describe, expect, it } from 'vitest';
import type { Bounds } from './clipping';
import { fitCamera } from './camera';

const bounds: Bounds = { min: [-100, -50, -450], max: [100, 50, -350] };

describe('fitCamera', () => {
  it('looks at the centre from the front (anterior = -y in LPS), superior up', () => {
    const fit = fitCamera(bounds, 35, 1.5);
    expect(fit.target).toEqual([0, 0, -400]);
    expect(fit.up).toEqual([0, 0, 1]);
    expect(fit.position[0]).toBe(0);
    expect(fit.position[2]).toBe(-400);
    expect(fit.position[1]).toBeLessThan(-150);
    expect(fit.near).toBeGreaterThan(0);
    expect(fit.far).toBeGreaterThan(-fit.position[1]);
  });

  it('backs off further in a narrow viewport', () => {
    expect(fitCamera(bounds, 35, 0.5).position[1]).toBeLessThan(
      fitCamera(bounds, 35, 2).position[1],
    );
  });
});
