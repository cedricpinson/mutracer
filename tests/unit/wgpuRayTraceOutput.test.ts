import { makeShaderDataDefinitions } from 'webgpu-utils';
import rayTraceCompute from '../../src/renderer/wgsl/rayTrace.compute';
import { SHADOW_CATCHER_ACCUMULATION_BYTES } from '../../src/renderer/wgsl/chunks/shadowCatcherAccumulation.wgsl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WGPURayTraceOutputPass, createNormalizeRayTraceOutputWGSL
} from '../../src/renderer/WGPURayTraceOutput';
import { jnlmGuideWGSL } from '../../src/renderer/WGPUJNLMDenoiser';

describe('WGPURayTraceOutputPass resource lifetime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retires resized textures after submitted GPU work completes', async () => {
    vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, COPY_DST: 2 });
    vi.stubGlobal('GPUTextureUsage', {
      RENDER_ATTACHMENT: 1,
      TEXTURE_BINDING: 2,
      COPY_SRC: 4
    });

    let finishSubmittedWork!: () => void;
    const submittedWorkDone = new Promise<void>((resolve) => {
      finishSubmittedWork = resolve;
    });
    const textures: Array<{
      descriptor: GPUTextureDescriptor;
      destroy: ReturnType<typeof vi.fn>;
    }> = [];
    const device = {
      createBuffer: vi.fn(() => ({})),
      createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
        const texture = { descriptor, destroy: vi.fn() };
        textures.push(texture);
        return texture;
      }),
      queue: {
        onSubmittedWorkDone: vi.fn(() => submittedWorkDone)
      }
    } as unknown as GPUDevice;
    const pass = new WGPURayTraceOutputPass(device);

    pass.setSize(1920, 1088);
    const oldTextures = textures.slice();
    pass.setSize(1280, 720);

    expect(oldTextures).toHaveLength(3);
    expect(device.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    oldTextures.forEach((texture) => {
      expect(texture.destroy).not.toHaveBeenCalled();
    });

    finishSubmittedWork();
    await submittedWorkDone;
    await new Promise((resolve) => setTimeout(resolve, 0));

    oldTextures.forEach((texture) => {
      expect(texture.destroy).toHaveBeenCalledOnce();
    });
  });

});

it('matches the auxiliary accumulation layout in tracing, normalization and the JNLM guide', () => {
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  try {
    for (const shader of [
      rayTraceCompute({ hasDisplacement: false }),
      createNormalizeRayTraceOutputWGSL(),
      createNormalizeRayTraceOutputWGSL(true),
      jnlmGuideWGSL
    ]) {
      const layout = makeShaderDataDefinitions(shader).structs.ShadowCatcherAccumulation;
      expect(layout.size).toBe(SHADOW_CATCHER_ACCUMULATION_BYTES);
      expect(layout.fields.mask.offset).toBe(0);
      expect(layout.fields.background.offset).toBe(16);
      expect(layout.fields.moments.offset).toBe(32);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

it('hands the catcher layers the flat background colour, and only them', () => {
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, COPY_DST: 2 });
  try {
    // The layers pass binds its uniform buffers in creation order: binding 2 is the third one.
    expect(makeShaderDataDefinitions(createNormalizeRayTraceOutputWGSL(true)).uniforms.flatBackground)
      .toMatchObject({ group: 1, binding: 2 });
    expect(makeShaderDataDefinitions(createNormalizeRayTraceOutputWGSL()).uniforms.flatBackground).toBeUndefined();

    const buffers: object[] = [];
    const writeBuffer = vi.fn();
    const device = {
      createBuffer: vi.fn(() => { const buffer = {}; buffers.push(buffer); return buffer; }),
      queue: { writeBuffer }
    } as unknown as GPUDevice;
    new WGPURayTraceOutputPass(device).setFlatBackground([0.1, 0.2, 0.3, 1]);

    expect(writeBuffer).toHaveBeenCalledOnce();
    expect(writeBuffer.mock.calls[0][0]).toBe(buffers[2]);
    expect(Array.from(writeBuffer.mock.calls[0][2] as Float32Array)).toEqual([0.1, 0.2, 0.3, 1].map(Math.fround));
  } finally {
    vi.unstubAllGlobals();
  }
});
