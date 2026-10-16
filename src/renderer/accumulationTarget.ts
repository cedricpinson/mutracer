import type { Scene } from '../scene/Scene.js';
import type { TraceSettings } from './renderPipeline.js';
import type { RenderPasses } from './RenderingPipeline.js';

/** Backend-owned execution and outputs of one resident accumulation. */
export interface TargetPipeline extends RenderPasses {
  activate(): void;
  invalidateDenoisedOutput(): void;
  /** Refreshes backend timing after structural scene changes; optional without GPU timestamps. */
  invalidateTiming?(): void;
  configure(settings: TraceSettings): void;
  synchronizeBackground(background: Scene['background']): void;
  canCompleteSampleWithin(timeBudgetMs: number): boolean;
  /** Last GPU-timestamped trace time of one whole sample, in ms; undefined without timestamps or before one. */
  gpuSampleTimeMs?(): number | undefined;
  present(): void;
  readPresentation(): Promise<{width: number; height: number; data: Float32Array}>;
  readonly presentationComplete: boolean;
  readonly presentationDenoised: boolean;
  getMemory(): {width: number; height: number; bytes: number};
}
