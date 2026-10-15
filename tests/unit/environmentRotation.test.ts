import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import { SceneEnvironmentCache } from '../../src/renderer/sceneLightChanges';
import { writeRotationUniform } from '../../src/renderer/WGPURayTracePass';
import EnvironmentLight from '../../src/scene/EnvironmentLight';
import Texture from '../../src/scene/Texture';
import { Scene } from '../../src/scene/Scene';
import { fromTHREEScene } from '../../src/util/fromTHREE';

const quarterTurnY = [0, 0, -1, 0, 1, 0, 1, 0, 0];
const envTexture = () => new Texture({ data: new Float32Array([1, 2, 3, 1]), width: 1, height: 1 });

describe('environment rotation', () => {
  it('defaults to identity and keeps the synthesized map across rotation edits', () => {
    const environment = new EnvironmentLight({ map: envTexture() });
    expect(Array.from(environment.rotation)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const cache = new SceneEnvironmentCache();
    const first = cache.update([environment]);
    environment.rotation[0] = 0; environment.rotation[2] = -1;
    expect(cache.update([environment])).toBe(first);
    environment.rotation = quarterTurnY;
    expect(cache.update([environment])).toBe(first);
    environment.map = envTexture();
    expect(cache.update([environment])).not.toBe(first);
  });

  it('reports environment and background rotation edits as light and background changes', () => {
    const environment = new EnvironmentLight({ map: envTexture() });
    const scene: Scene = { meshes: [], lights: [environment], background: envTexture() };
    const detector = new SceneChangeDetector();
    detector.detect(scene); detector.commit();
    environment.rotation[0] = -1;
    expect(detector.detect(scene)).toMatchObject({ lights: true, background: false });
    detector.commit();
    scene.backgroundRotation = quarterTurnY;
    expect(detector.detect(scene)).toMatchObject({ lights: false, background: true });
    detector.commit();
    expect(detector.detect(scene)).toMatchObject({ lights: false, background: false });
  });

  it('packs column-major rotations into padded WGSL mat3x3f columns', () => {
    const view = new Float32Array(12).fill(9);
    writeRotationUniform(view, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(view)).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    writeRotationUniform(view);
    expect(Array.from(view)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it('converts Three.js environmentRotation and backgroundRotation', () => {
    const scene = new THREE.Scene();
    const environment = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    scene.environment = environment;
    scene.background = environment;
    scene.environmentRotation.set(0, Math.PI / 2, 0);
    scene.backgroundRotation.set(0, -Math.PI / 2, 0);
    const converted = fromTHREEScene(scene);
    const light = converted.lights.find(item => item.type === 'EnvironmentLight') as EnvironmentLight;
    const expected = (euler: THREE.Euler) => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler)).elements;
    expect(Array.from(light.rotation)).toEqual(expected(scene.environmentRotation).map(value => expect.closeTo(value, 12)));
    expect(converted.backgroundRotation).toEqual(expected(scene.backgroundRotation).map(value => expect.closeTo(value, 12)));

    scene.background = new THREE.Color(0x336699);
    expect(fromTHREEScene(scene).backgroundRotation).toBeUndefined();
  });
});
