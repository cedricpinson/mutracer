// Open on a real GPU; ?webgl checks the fallback backend. Like
// THREE.ShadowMaterial, a shadow catcher's alpha scales the shadow it shows:
// opacity 0.5 halves the shadow's darkening, opacity 0 leaves the backdrop, and
// an alphaMap scales it per pixel. Coverage stays whole, so the model never
// changes. Known limit: on WebGL 2 an alphaMap that varies over the catcher is
// not resolved per pixel (a ramp reads as its mean), so only a uniform alphaMap
// is asserted there; the ramp is asserted on WebGPU.
import {Camera, Engine, EnvironmentLight, Mesh, OpenPBRMaterial, ProceduralSky, Render, Texture,
  createCubeGeometry, createPlaneGeometry} from '../../src/main.js';

const WIDTH = 160, HEIGHT = 96, SAMPLES = 128;

async function displayPixels(engine: Engine, render: Render) {
  const blob = await engine.display.toBlob(render);
  const bitmap = await createImageBitmap(blob), image = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = image.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
  const preview = document.createElement('img'); preview.src = URL.createObjectURL(blob); document.body.append(preview);
  return context.getImageData(0, 0, image.width, image.height).data;
}

const luminance = (pixels: Uint8ClampedArray, i: number) => .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];

async function capture() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const webgl = location.search.includes('webgl');
  const engine = new Engine({canvas, backend: webgl ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {width: WIDTH, height: HEIGHT, bounces: 2, bevel: false});
  const catcher = new OpenPBRMaterial({shadowCatcher: true});
  const plane = new Mesh(createPlaneGeometry(), catcher);
  plane.transform[0] = plane.transform[10] = 4;
  const cube = new Mesh(createCubeGeometry(), new OpenPBRMaterial({baseColor: [.6, .6, .6]}));
  cube.transform[0] = cube.transform[5] = cube.transform[10] = .5;
  cube.transform[12] = -.9; cube.transform[13] = .5;
  const camera = new Camera({projection: 'perspective', fov: 40});
  camera.position = [0, 2.2, 3.6]; camera.lookAt([0, .2, 0]);
  const sky = new ProceduralSky({resolution: [512, 256], time: 15});
  engine.camera = camera; engine.display.setSize(WIDTH, HEIGHT);
  // Uniform alphaMap at half; and a ramp along the plane's v (which runs along x), so the alpha
  // changes across the shadow.
  const half = new Texture({width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255])});
  const ramp = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const v = Math.round(255 * y / 63); ramp.set([v, v, v, 255], (y * 64 + x) * 4); }
  const rampMap = new Texture({width: 64, height: 64, data: ramp});
  const variants: {name: string; opacity: number; alphaMap?: Texture; offset?: number}[] = [
    {name: 'opacity 1', opacity: 1},
    {name: 'opacity 1, other sequence', opacity: 1, offset: 1000},
    {name: 'opacity 0.5', opacity: .5},
    {name: 'opacity 0', opacity: 0},
    {name: 'alphaMap 0.5', opacity: 1, alphaMap: half},
    {name: 'alphaMap ramp', opacity: 1, alphaMap: rampMap}
  ];
  try {
    const info = await engine.init();
    const lights = [new EnvironmentLight({map: sky})];
    // Object mask: everything the camera sees without the catcher, dilated by one pixel.
    engine.scene = {meshes: [cube], lights, background: [1, 1, 1, 1]};
    engine.update();
    await render.converge({samples: 4, sampleSequenceOffset: 0});
    const objects = await displayPixels(engine, render);
    const isObject = (i: number) => {
      const x = (i / 4) % WIDTH, y = Math.floor(i / 4 / WIDTH);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = (Math.min(HEIGHT - 1, Math.max(0, y + dy)) * WIDTH + Math.min(WIDTH - 1, Math.max(0, x + dx))) * 4;
        if ([0, 1, 2].some(ch => Math.abs(objects[j + ch] - objects[ch]) > 1)) return true;
      }
      return false;
    };
    const images: Uint8ClampedArray[] = [];
    for (const variant of variants) {
      catcher.geometryOpacity = variant.opacity;
      catcher.alphaMap = variant.alphaMap;
      catcher.alphaMode = variant.opacity < 1 || variant.alphaMap ? 'blend' : 'opaque';
      engine.scene = {meshes: [plane, cube], lights, background: [1, 1, 1, 1]};
      engine.update();
      await render.converge({samples: SAMPLES, sampleSequenceOffset: variant.offset ?? 0});
      images.push(await displayPixels(engine, render));
    }
    const [full, fullOther, halfOpacity, zero, halfMap, ramped] = images;
    // The backdrop is whatever the corner shows (backends tone map it differently).
    const backdrop = luminance(zero, 0);
    // Shadow zone: clearly darker than the backdrop with the full-opacity catcher, off the model.
    const zone: number[] = [];
    for (let i = 0; i < full.length; i += 4) {
      if (!isObject(i) && backdrop - luminance(full, i) > 30 && backdrop - luminance(fullOther, i) > 30) zone.push(i);
    }
    const mean = (image: Uint8ClampedArray, indices: number[]) => indices.reduce((sum, i) => sum + luminance(image, i), 0) / Math.max(indices.length, 1);
    const darkening = (image: Uint8ClampedArray) => backdrop - mean(image, zone);
    let zeroMax = 0;
    for (const i of zone) zeroMax = Math.max(zeroMax, Math.abs(luminance(zero, i) - backdrop));
    // Ramp map: the alpha estimate of each shadow pixel is its remaining darkening over the full one.
    const estimates = zone.map(i => (backdrop - luminance(ramped, i)) / (backdrop - luminance(full, i)));
    const rampSpread = Math.max(...estimates) - Math.min(...estimates);
    const rampMean = estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
    const results = {
      zonePixels: zone.length,
      backdrop: +backdrop.toFixed(1),
      darkeningFull: +darkening(full).toFixed(2),
      opacityHalfOverFull: +(darkening(halfOpacity) / darkening(full)).toFixed(3),
      alphaMapHalfOverFull: +(darkening(halfMap) / darkening(full)).toFixed(3),
      opacityZeroMaxDeltaFromBackdrop: +zeroMax.toFixed(1),
      noiseFullVsOtherSequence: +Math.abs(mean(full, zone) - mean(fullOther, zone)).toFixed(3),
      rampMapAlphaEstimate: {mean: +rampMean.toFixed(3), spread: +rampSpread.toFixed(3)}
    };
    // On WebGPU the ramp must show through (spread over the shadow); the shadow lies where v is about .25 to .4.
    const rampOk = webgl || (rampSpread > .08 && rampMean > .2 && rampMean < .45);
    const pass = zone.length > 50 &&
      Math.abs(results.opacityHalfOverFull - .5) < .05 && Math.abs(results.alphaMapHalfOverFull - .5) < .05 &&
      zeroMax <= 2 && rampOk;
    return {backend: engine.backend, adapter: info.adapterName, results, pass};
  } finally { render.dispose(); engine.dispose(); }
}
const result = document.querySelector('#result')!;
capture().then(value => { result.textContent = JSON.stringify(value, null, 2); },
  error => { result.textContent = `${error}\n${error.stack ?? ''}`; });
