// Three.js stage: renderer + tone mapping + environment lighting + bloom, and the timeline hook.
// Resolved through the import map in index.html ("three" and "three/addons/").
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export * from './math.js';
export { THREE };

/**
 * Creates renderer, scene, camera and post-processing.
 *  - preserveDrawingBuffer is required: the screenshot is taken after seek() returns.
 *  - The composer renders into a 4x multisampled HDR target (antialiasing + values above 1.0 for bloom).
 *  - A built-in studio environment (no files to download) gives metals and glass something to reflect.
 *  - The `renderer.setPixelRatio(devicePixelRatio)` call is what makes `render.mjs --scale 2` give sharper output.
 */
export function createStage({
  background = 0x05060a,
  fov = 40,
  exposure = 1.0,
  envIntensity = 0.6,
  bloom = { strength: 0.8, radius: 0.6, threshold: 0.85 }, // set to null to disable
} = {}) {
  const w = window.innerWidth, h = window.innerHeight, dpr = window.devicePixelRatio || 1;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = envIntensity;

  const camera = new THREE.PerspectiveCamera(fov, w / h, 0.1, 200);

  const target = new THREE.WebGLRenderTarget(w * dpr, h * dpr, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  let bloomPass = null;
  if (bloom) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), bloom.strength, bloom.radius, bloom.threshold);
    composer.addPass(bloomPass);
  }
  composer.addPass(new OutputPass()); // applies tone mapping + sRGB conversion last

  return { THREE, renderer, scene, camera, composer, bloomPass, render: () => composer.render() };
}

/**
 * Connects the scene to the renderer script.
 *   update(t)  - set every animated value for time t (seconds). Must be a pure function of t.
 *   render()   - draw the frame (stage.render)
 * Adding ?live to the page URL plays it as a real-time loop in a normal browser tab for previewing.
 */
export function installTimeline({ duration, update, render }) {
  const seek = (t) => { update(t); render(); };
  window.__duration = duration;
  window.seek = seek;
  if (new URLSearchParams(location.search).has('live')) {
    const start = performance.now();
    const loop = () => { seek(((performance.now() - start) / 1000) % duration); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  } else {
    seek(0); // never leave the first frame black
  }
  window.__ready = true;
}
