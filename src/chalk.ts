import * as THREE from "three";

// Golden chalk power-up. Idles in the lower-right area (just LEFT of the tomato),
// camera-anchored, spinning slowly on a tilted axis so it reads as an active
// item. The speller clicks it to arm "aim mode", then picks a letter slot on the
// board to reveal. Placeholder geometry — swap buildChalk() for a loaded .glb
// later (keep the same ~1-unit size).

export interface ChalkView {
  group: THREE.Group;
  setVisible(v: boolean): void;
  setActive(v: boolean): void; // active = gold + hover effects; inactive = greyed out
  setHover(v: boolean): void; // hover = subtle scale-up + glow (only when active)
  update(dt: number): void; // anchor + spin idle
  hitTest(ndcX: number, ndcY: number): boolean; // pointer over the idle chalk
}

// Idle pose in camera space (-Z forward). Left of the tomato (which sits at x≈0.74).
const IDLE = { pos: new THREE.Vector3(0.44, -0.46, -1.35), scale: 0.34 };
// Spin about the stick's OWN long axis (centered), leaned over the same way the
// tomato tilts — so it rotates cleanly in place instead of sweeping a pivot.
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TILT_DIR = new THREE.Vector3(0.30, 1, 0.06).normalize(); // lean, matching the tomato
const SPIN_SPEED = 0.85; // rad/s
const HOVER_SCALE = 0.14;
const BASE_GLOW = 0.7; // resting emissive glow (active chalk) — clearly self-lit
const HOVER_GLOW = 0.6; // extra emissive on hover

const GOLD = 0xfff2bf; // white-yellow when available
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
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const spinner = buildChalk();
  group.add(spinner);
  scene.add(group);
  const bodyMat = (spinner.getObjectByName("chalkBody") as THREE.Mesh).material as THREE.MeshStandardMaterial;

  let visible = false;
  let active = true; // white-yellow + interactive; false = dark grey "not your turn"
  let spin = 0;
  let hover = false;
  let hoverAmt = 0;

  const applyTint = () => {
    bodyMat.color.setHex(active ? GOLD : GREY);
    bodyMat.emissive.setHex(active ? GOLD : 0x000000);
  };

  const local = new THREE.Matrix4();
  const idq = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // tilt = lean Y over to TILT_DIR; spin = rotate about local Y. Composing
  // tiltQ * spinQ spins the stick about its own (leaned) long axis, centered.
  const tiltQ = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, TILT_DIR);
  const spinQ = new THREE.Quaternion();

  const update = (dt: number) => {
    group.visible = visible;
    if (visible) {
      hoverAmt += ((hover ? 1 : 0) - hoverAmt) * Math.min(1, dt * 12);
      const eff = active ? hoverAmt : 0; // greyed chalk never scales/glows
      // Active chalk has a constant soft glow; hover brightens it. Greyed = none.
      bodyMat.emissiveIntensity = active ? BASE_GLOW + HOVER_GLOW * eff : 0;
      const s = IDLE.scale * (1 + HOVER_SCALE * eff);
      spin += dt * SPIN_SPEED;
      spinQ.setFromAxisAngle(Y_AXIS, spin);
      spinner.quaternion.copy(tiltQ).multiply(spinQ);
      camera.updateMatrixWorld();
      local.compose(IDLE.pos, idq, sc.set(s, s, s));
      group.matrix.multiplyMatrices(camera.matrixWorld, local);
      group.matrixWorldNeedsUpdate = true;
    } else if (hoverAmt !== 0) {
      hoverAmt = 0;
      bodyMat.emissiveIntensity = 0;
    }
  };

  applyTint();
  return {
    group,
    setVisible: (v) => { visible = v; if (!v) hover = false; },
    setActive: (v) => { if (active !== v) { active = v; applyTint(); } },
    setHover: (v) => { hover = v; },
    update,
    hitTest: (x, y) => {
      if (!visible) return false;
      ndc.set(x, y);
      ray.setFromCamera(ndc, camera);
      return ray.intersectObject(group, true).length > 0;
    },
  };
}
