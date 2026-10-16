import { afterEach, describe, expect, it, vi } from 'vitest';
import rayTraceCompute from '../../src/renderer/wgsl/rayTrace.compute';
import shadowCatcherFrag from '../../src/renderer/glsl/shadowCatcher.frag';

afterEach(() => { vi.unstubAllGlobals(); });

// A catcher pixel whose resolved alpha (opacity, alphaMap) is zero has zero
// shadow opacity whatever its visibility. Both backends must skip the shadow
// rays there, and gate them on the same resolved value that scales the result.
function catcherBranch(source: string, start: RegExp, end: RegExp) {
  const from = source.search(start);
  expect(from, 'catcher branch start').toBeGreaterThanOrEqual(0);
  const rest = source.slice(from);
  const to = rest.search(end);
  expect(to, 'catcher branch end').toBeGreaterThan(0);
  return rest.slice(0, to);
}

function expectAlphaGatedShadowRays(branch: string, guard: RegExp, use: RegExp) {
  const resolve = branch.search(/catcherAlpha\s*=\s*clamp\(\s*(?:ma|mat)\.alpha\s*,\s*0\.0\s*,\s*1\.0\s*\)/);
  const gate = branch.search(guard);
  const sample = branch.search(/sampleShadowCatcher\(/);
  const scale = branch.search(use);
  expect(resolve).toBeGreaterThanOrEqual(0);
  expect(gate).toBeGreaterThan(resolve);
  expect(sample).toBeGreaterThan(gate);
  expect(scale).toBeGreaterThan(sample);
  // The raw material alpha is not read again after the gate.
  expect(branch.slice(gate)).not.toMatch(/\b(?:ma|mat)\.alpha\b/);
}

describe('shadow catcher early-out at zero catcher alpha', () => {
  it('skips the WebGPU shadow rays where the resolved alpha is zero', () => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    const branch = catcherBranch(
      rayTraceCompute({ hasDisplacement: false }),
      /if \(ma\.materialType == SHADOW_CATCHER\) \{/,
      /\n {2}\}\n {2}else \{/
    );
    expectAlphaGatedShadowRays(
      branch,
      /if \(catcherAlpha <= 0\.0\) \{\s*return vec4f\(vec3f\(1\.0\), 0\.0\);/,
      /return vec4f\(vec3f\(1\.0\), path\.alpha \* catcherAlpha\);/
    );
  });

  it('skips the WebGL 2 shadow rays where the resolved alpha is zero', () => {
    const branch = catcherBranch(
      shadowCatcherFrag.main,
      /if \(mat\.materialType != SHADOW_CATCHER\)/,
      /\n\}\n/
    );
    expectAlphaGatedShadowRays(
      branch,
      /if \(!path\.abort && catcherAlpha > 0\.0\) \{/,
      /visibility = 1\.0 - \(1\.0 - path\.alpha\) \* catcherAlpha;/
    );
  });
});
