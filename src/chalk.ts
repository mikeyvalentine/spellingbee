import * as THREE from "three";
import { makePowerup } from "./powerup";

// Golden chalk power-up. Idles just LEFT of the tomato (camera-anchored) via the
// shared power-up base, which handles the hover + disabled states. The speller
// clicks it to arm aim mode, then picks a board slot to reveal. Placeholder
// geometry — swap buildChalk() for a loaded .glb later (keep the ~1-unit size).

export interface ChalkView {
  group: THREE.Group;
  setVisible(v: boolean): void;
  setActive(v: boolean): void; // active = your turn (usable); else disabled
  setHover(v: boolean): void;
  update(dt: number): void;
  hitTest(ndcX: number, ndcY: number): boolean;
}

const IDLE = { pos: new THREE.Vector3(0.44, -0.46, -1.35), scale: 0.34 };
// Spin about the stick's own long axis, leaned over like the tomato's tilt.
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TILT_DIR = new THREE.Vector3(0.30, 1, 0.06).normalize();
const SPIN_SPEED = 0.85; // rad/s
const HOVER_SCALE = 0.14;
// With bloom threshold ≈1.36, the emissive must sit just above it for a SUBTLE
// rim glow (the low bloom strength/radius keep the halo small) — not the blown
// blob a high emissive produced. Tunable alongside the bloom debug sliders.
const BASE_GLOW = 1.55; // resting emissive (active)
const HOVER_GLOW = 0.4; // extra emissive on hover

const GOLD = 0xfff7df; // soft yellow-white when available
const GREY = 0x44444a; // dark grey when "not your turn"

function buildChalk(): THREE.Group {
  const g = new THREE.Group();
  // A plain low-poly cylinder, one material, centered at the origin so it spins
  // cleanly about its own long (Y) axis.
  const mat = new THREE.MeshStandardMaterial({
    color: GOLD, roughness: 0.55, metalness: 0.1, emissive: GOLD, emissiveIntensity: 0,
  });
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.0, 10, 1), mat);
  stick.name = "chalkBody";
  g.add(stick);
  g.renderOrder = 998;
  g.traverse((o) => { (o as THREE.Mesh).renderOrder = 998; });
  return g;
}

export function makeChalk(camera: THREE.PerspectiveCamera, scene: THREE.Scene): ChalkView {
  const spinner = buildChalk();
  const bodyMat = (spinner.getObjectByName("chalkBody") as THREE.Mesh).material as THREE.MeshStandardMaterial;
  bodyMat.emissive.setHex(GOLD);
  const GOLD_C = new THREE.Color(GOLD), GREY_C = new THREE.Color(GREY);
  const tiltQ = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, TILT_DIR);
  const spinQ = new THREE.Quaternion();

  const pu = makePowerup({
    camera, scene, spinner, materials: [bodyMat],
    idlePos: IDLE.pos, scale: IDLE.scale, spinSpeed: SPIN_SPEED,
    applySpin: (s, a) => { spinQ.setFromAxisAngle(Y_AXIS, a); s.quaternion.copy(tiltQ).multiply(spinQ); },
    hoverScale: HOVER_SCALE,
    applyState: (active, hover) => {
      // Tween gold⇄grey + fade the glow with the active amount (smooth disable).
      bodyMat.color.copy(GREY_C).lerp(GOLD_C, active);
      bodyMat.emissiveIntensity = (BASE_GLOW + HOVER_GLOW * hover) * active;
    },
  });

  return {
    group: pu.group,
    setVisible: pu.setVisible,
    setActive: pu.setActive,
    setHover: pu.setHover,
    update: pu.update,
    hitTest: pu.hitTest,
  };
}
