import { getSphereLightArea, getSpotLightArea, getSpotLightRadiance } from '../../src/renderer/lightsUtil.js';
import { describe, expect, it } from 'vitest';
import {
  buildLightAliasTable,
  buildShadowCatcherLightAliasTable,
  collectEmissiveTriangles,
  estimateAnalyticLightPower,
  LightChoiceBuffer,
  LIGHT_CHOICE_ANALYTIC,
  LIGHT_CHOICE_EMISSIVE_TRIANGLE,
  LIGHT_CHOICE_ENVIRONMENT,
  packEmissiveTriangles
} from '../../src/renderer/lightSampling';
import RectLight from '../../src/scene/RectLight';
import SphereLight from '../../src/scene/SphereLight';
import SpotLight from '../../src/scene/SpotLight';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { Attribute } from '../../src/scene/Geometry';
import { createPlaneGeometry } from '../../src/util/commonGeometry';
import Texture from '../../src/scene/Texture';
import createRayTraceGlsl from '../../src/renderer/glsl/rayTrace.frag';
import sampleLight from '../../src/renderer/wgsl/chunks/sampleLight.wgsl';

describe('power-weighted light sampling', () => {
  it('does not treat delta directional lights as finite geometry hits', () => {
    const rayTraceGlsl = createRayTraceGlsl();
    expect(rayTraceGlsl.main).toContain('float d = INF');
    expect(rayTraceGlsl.main).not.toContain('float d;');
  });

  it('normalizes PMFs and creates valid alias entries', () => {
    const result = buildLightAliasTable(
      [1, 3, 6].map((weight, sourceIndex) => ({
        sourceType: LIGHT_CHOICE_ANALYTIC,
        sourceIndex,
        weight
      }))
    );
    expect(result.pmfs[0]).toBeCloseTo(0.1);
    expect(result.pmfs[1]).toBeCloseTo(0.3);
    expect(result.pmfs[2]).toBeCloseTo(0.6);
    expect(result.totalWeight).toBe(10);
    const probabilities = new Float32Array(result.choices.buffer);
    const aliases = new Int32Array(result.choices.buffer);
    for (let i = 0; i < 3; i++) {
      expect(probabilities[i * 4]).toBeGreaterThan(0);
      expect(probabilities[i * 4]).toBeLessThanOrEqual(1);
      expect(aliases[i * 4 + 1]).toBeGreaterThanOrEqual(0);
      expect(aliases[i * 4 + 1]).toBeLessThan(3);
    }
  });

  it('weights an area light by luminance and area', () => {
    const light = new RectLight({size: [2, 3], color: [1, 1, 1], intensity: 4});
    expect(estimateAnalyticLightPower(light)).toBeCloseTo(24 * Math.PI);
  });

  it('keeps zero-radius sphere and spot emitters finite, weighted, and delta', () => {
    const point = Object.assign(new SphereLight({color: [1, 0.5, 0.25], intensity: 12, radius: 0}), {position: [0, 0, 0]});
    const spot = (() => { const light = new SpotLight({color: [1, 0.5, 0.25], intensity: 12, radius: 0, innerAngle: 10, outerAngle: 30}); const p = [0, 0, 0], d = [0, 0, -1]; light.position = [p[0], p[1], p[2]]; light.lookAt([p[0]+d[0], p[1]+d[1], p[2]+d[2]]); return light; })();
    expect(getSphereLightArea(point)).toBe(0);
    expect(getSpotLightArea(spot)).toBe(0);
    expect(getSpotLightRadiance(spot)).toBe(12);
    expect(estimateAnalyticLightPower(point)).toBeGreaterThan(0);
    expect(estimateAnalyticLightPower(spot)).toBeGreaterThan(0);
    expect(Number.isFinite(getSpotLightRadiance(spot))).toBe(true);
    expect(sampleLight).toContain('light.radiusOrSpread <= 0.0');
    expect(sampleLight).toContain('centerDistance * centerDistance');
  });

  it('collects and packs emissive mesh triangles in world space', () => {
    const material = new OpenPBRMaterial();
    material.emissionColor = [2, 1, 0.5];
    material.emissionLuminance = 3;
    const geometry = createPlaneGeometry();
    geometry.uv1 = new Attribute(
      Float32Array.from(geometry.uv!.array, (value) => 1 - value),
      2
    );
    const mesh = new Mesh(geometry, material);
    mesh.transform[12] = 5;
    const triangles = collectEmissiveTriangles(
      [{ mesh, geometry: mesh.geometry, materialIndices: [0] }],
      [material]
    );

    expect(triangles).toHaveLength(2);
    expect(triangles[0].p0[0]).toBeGreaterThanOrEqual(4);
    expect(triangles[0].samplingLuminance).toBeGreaterThan(0);
    expect(triangles[0].secondaryUv0).not.toEqual(triangles[0].uv0);
    const packed = packEmissiveTriangles(triangles);
    expect(packed).toHaveLength(48);
    expect(Array.from(packed.slice(18, 24))).toEqual([
      ...triangles[0].secondaryUv0,
      ...triangles[0].secondaryUv1,
      ...triangles[0].secondaryUv2
    ]);
    expect(sampleLight).toContain(
      'i32(triangle.materialIndex), uv, secondaryUv'
    );
  });

  it('does not sample unlit surfaces as mesh lights', () => {
    const material = new OpenPBRMaterial();
    material.unlit = true;
    material.emissionColor = [1, 1, 1];
    material.emissionLuminance = 1;
    const mesh = new Mesh(createPlaneGeometry(), material);
    expect(collectEmissiveTriangles(
      [{ mesh, geometry: mesh.geometry, materialIndices: [0] }],
      [material]
    )).toHaveLength(0);
  });
});

describe('shadow-catcher light table', () => {
  // Same weights as WGPURayTracePass._updateLightSamplingData.
  function sceneChoices(emissiveMap?: Texture) {
    const material = new OpenPBRMaterial();
    material.emissionColor = [1, 1, 1];
    material.emissionLuminance = 10;
    material.emissiveMap = emissiveMap;
    const mesh = new Mesh(createPlaneGeometry(), material);
    const triangles = collectEmissiveTriangles(
      [{ mesh, geometry: mesh.geometry, materialIndices: [0] }],
      [material]
    );
    const choices = new LightChoiceBuffer();
    choices.reserve(2 + triangles.length);
    choices.push(LIGHT_CHOICE_ENVIRONMENT, 0, 1);
    choices.push(LIGHT_CHOICE_ANALYTIC, 0, 3);
    triangles.forEach((triangle, i) => choices.push(LIGHT_CHOICE_EMISSIVE_TRIANGLE, i, triangle.area * triangle.samplingLuminance));
    return choices;
  }

  it('leaves out emissive triangles, even those a black emission texture turns off', () => {
    // Mesh-light power ignores the emission texture, so a black-textured
    // emitter still dominates the main table.
    const choices = sceneChoices(new Texture({data: new Uint8Array(16), width: 2, height: 2}));
    const main = buildLightAliasTable(choices);
    expect(main.pmfs[2] + main.pmfs[3]).toBeGreaterThan(0.8);

    const catcher = buildShadowCatcherLightAliasTable(choices)!;
    expect(catcher.pmfs.length).toBe(2);
    expect(catcher.pmfs[0]).toBeCloseTo(0.25);
    expect(catcher.pmfs[1]).toBeCloseTo(0.75);
    // Each entry keeps its main-table source so sampleLightChoiceTable reads the same light.
    const entries = new Int32Array(catcher.choices.buffer);
    expect([entries[2], entries[3], entries[6], entries[7]]).toEqual([
      LIGHT_CHOICE_ENVIRONMENT, 0, LIGHT_CHOICE_ANALYTIC, 0
    ]);
  });

  it('shares the main table when the scene has no emissive mesh', () => {
    const choices = new LightChoiceBuffer();
    choices.reserve(2);
    choices.push(LIGHT_CHOICE_ENVIRONMENT, 0, 1);
    choices.push(LIGHT_CHOICE_ANALYTIC, 0, 3);
    expect(buildShadowCatcherLightAliasTable(choices)).toBeUndefined();
  });

  it('is empty when only emissive meshes light the scene', () => {
    const choices = new LightChoiceBuffer();
    choices.reserve(1);
    choices.push(LIGHT_CHOICE_EMISSIVE_TRIANGLE, 0, 5);
    expect(buildShadowCatcherLightAliasTable(choices)!.pmfs.length).toBe(0);
  });
});
