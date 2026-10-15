import { SceneLight } from '../scene/Scene.js';
import { snapshotFields, snapshotsEqual } from './sceneChangeDetector.js';
import { generateEnvMapFromSceneComponents } from './envMapCreation.js';
import { EnvironmentMapSource } from './envMapDistribution.js';
import Texture from '../scene/Texture.js';
import EnvironmentLight from '../scene/EnvironmentLight.js';

function environmentSnapshot(light: EnvironmentLight) {
  const { rotation: _rotation, ...fields } = light;
  return [light, ...snapshotFields(fields).slice(1)];
}

/** Synthesized environment data is retained across analytic-light and rotation edits. */
export class SceneEnvironmentCache {
  private _snapshot: unknown[][] = [];
  private _image?: EnvironmentMapSource;
  update(lights: readonly SceneLight[]) {
    const ambient = lights.filter(light => light.type === 'AmbientLight');
    const environment = lights.filter(light => light.type === 'EnvironmentLight');
    // Rotation is a shader uniform: leaving it out keeps the map and its distribution.
    const next = [...ambient.map(snapshotFields), ...environment.map(environmentSnapshot)];
    if (next.length !== this._snapshot.length ||
      next.some((value, i) => !snapshotsEqual(value, this._snapshot[i]))) {
      this._image = next.length ? generateEnvMapFromSceneComponents(ambient, environment) : undefined;
      this._snapshot = next;
    }
    return this._image;
  }
}

/** Captures values before callers mutate a RectLight or its Texture in place. */
export class RectLightTextureTracker {
  private _snapshot: unknown[] = [];
  private _hadTexture = false;
  update(lights: readonly SceneLight[]) {
    const textures = lights.map(light => light.type === 'RectLight' ? light.texture : undefined);
    const next = textures.flatMap(texture => texture ? [texture, texture.version, texture.image,
      texture.flipY, ...texture.uvScale, ...texture.uvOffset, texture.uvChannel] : [undefined]);
    const hasTexture = textures.some((texture): texture is Texture => !!texture);
    const changed = (this._hadTexture || hasTexture) && !snapshotsEqual(next, this._snapshot);
    this._snapshot = next;
    this._hadTexture = hasTexture;
    return changed;
  }
}
