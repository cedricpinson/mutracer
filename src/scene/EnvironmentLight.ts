import type { Mat3 } from '../types.js';
import { mat3 } from '../math.js';
import Texture from './Texture.js';

/**
 * Image-based lighting from an equirectangular (latitude-longitude) HDR map,
 * for example one loaded with `loadRGBE()`. Importance sampled.
 */
export default class EnvironmentLight {
  /** Light discriminator; always `EnvironmentLight`. */
  readonly type = 'EnvironmentLight' as const;
  /** Equirectangular radiance map in linear color. */
  map: Texture;
  /**
   * Orientation of the map in world space: column-major 3×3 rotation (gl-matrix layout) that
   * takes a map direction to a world direction. Default identity. Also orients the
   * environment shown as the background when `Scene.background` is omitted. Editing it only
   * updates a uniform; the map and its sampling distribution are kept.
   */
  rotation: Mat3 = mat3.create();
  constructor(params: {
    /** Required equirectangular radiance map; no default. */ map: Texture;
    /** Map-to-world rotation. Default identity. */ rotation?: Mat3;
  }) {
    this.map = params.map;
    if (params.rotation) this.rotation = params.rotation;
  }
}
