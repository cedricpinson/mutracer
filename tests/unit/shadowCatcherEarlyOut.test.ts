// Locks the shadow-catcher alpha contract on both backends: the catcher's
// resolved alpha (opacity, alphaMap) scales the shadow it shows, and shadow
// rays are skipped where that alpha is zero. The light sample still counts in
// the total, so the skip is bit-identical to tracing it. The rationale lives
// above sampleShadowCatcher() in src/renderer/wgsl/chunks/sampleShadowCatcher.wgsl.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import rayTraceCompute from '../../src/renderer/wgsl/rayTrace.compute';
import shadowCatcherFrag from '../../src/renderer/glsl/shadowCatcher.frag';
import sampleShadowCatcherWgsl from '../../src/renderer/wgsl/chunks/sampleShadowCatcher.wgsl';
import sampleShadowCatcherGlsl from '../../src/renderer/glsl/chunks/sampleShadowCatcher.glsl';

afterEach(() => { vi.unstubAllGlobals(); });

describe('shadow catcher alpha and early-out', () => {
  it('passes the resolved alpha into the WebGPU sampler, which scales and gates on it', () => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    expect(rayTraceCompute({ hasDisplacement: false }))
      .toMatch(/sampleShadowCatcher\(si, 0, &path, clamp\(ma\.alpha, 0\.0, 1\.0\)\)/);
    expect(sampleShadowCatcherWgsl).toMatch(/catcherAlpha: f32\) -> vec2f/);
    expect(sampleShadowCatcherWgsl)
      .toMatch(/let occluded = catcherAlpha > 0\.0 && intersectSceneShadow\(/);
    expect(sampleShadowCatcherWgsl)
      .toMatch(/counts \+= vec2f\(select\(0\.0, catcherAlpha, occluded\), 1\.0\);/);
  });

  it('passes the resolved alpha into the WebGL 2 sampler, which scales and gates on it', () => {
    expect(shadowCatcherFrag.main)
      .toMatch(/sampleShadowCatcher\(si, 0, path, clamp\(mat\.alpha, 0\.0, 1\.0\)\)/);
    expect(sampleShadowCatcherGlsl).toMatch(/float catcherAlpha\) \{/);
    expect(sampleShadowCatcherGlsl)
      .toMatch(/bool occluded = catcherAlpha > 0\.0 && intersectSceneShadow\(/);
    expect(sampleShadowCatcherGlsl)
      .toMatch(/counts \+= vec2\(occluded \? catcherAlpha : 0\.0, 1\.0\);/);
  });

  it('counts every light sample that reaches the visible side, even where the alpha is zero', () => {
    // The total must not depend on the alpha, or the ratio of sums would shift
    // where the alpha crosses zero inside a pixel.
    for (const source of [sampleShadowCatcherWgsl, sampleShadowCatcherGlsl]) {
      const gate = source.indexOf('catcherAlpha > 0.0 &&');
      const total = source.search(/, 1\.0\);\n/);
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(total).toBeGreaterThan(gate);
      expect(source).not.toMatch(/if \(catcherAlpha/);
    }
  });
});
