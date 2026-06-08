import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  clock: THREE.Clock;
  render: () => void; // draws a frame (through the bloom composer on desktop)
  bloom: UnrealBloomPass | null; // desktop bloom pass (for the debug sliders)
}

export function setupScene(): SceneContext {
  const canvas = document.getElementById("app") as HTMLCanvasElement;

  // Mobile profile: drop antialias, lower the DPR cap, and disable shadows (an
  // extra scene pass). These are the biggest GPU levers on phones; desktop is
  // unchanged.
  const isMobile = window.matchMedia("(pointer: coarse)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = !isMobile;
  if (!isMobile) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  RectAreaLightUniformsLib.init(); // required before any RectAreaLight is shaded

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10131a);

  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(0, 3.5, 8);
  camera.lookAt(0, 1.6, -4);

  // --- Ambient base only. The bulk of the classroom lighting comes from the
  // interior point lights + window area light added in classroom.ts (so the
  // ceiling doesn't shadow an external key light into darkness). ---
  scene.add(new THREE.AmbientLight(0xfff2e0, 0.35)); // warm white
  scene.add(new THREE.HemisphereLight(0xf2e9d6, 0x2a2620, 0.35)); // warm sky/ground

  const clock = new THREE.Clock();

  // --- Bloom (desktop only). A light UnrealBloom pass so the emissive golden
  // chalk (and other very-bright/emissive bits) gets a soft halo. Skipped on
  // mobile — post-processing is an extra full-screen pass we don't want there.
  // RenderPass draws the scene linearly into the composer; OutputPass applies
  // tone mapping + sRGB at the very end (so colors match the no-bloom path).
  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  if (!isMobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // threshold 1.0 sits ABOVE the brightest board content (white chalk text ≈
    // 0.88 luminance) so the lettering never blooms — only the much brighter
    // emissive golden chalk (≈1.7) does. Tunable live via the debug panel.
    bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.85, // strength
      0.5, // radius
      1.0 // threshold
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    composer.setSize(window.innerWidth, window.innerHeight);
  }

  const render = () => {
    if (composer) composer.render();
    else renderer.render(scene, camera);
  };

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer?.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, clock, render, bloom };
}
