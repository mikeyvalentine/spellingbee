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
const SPIN_AXIS = new THREE.Vector3(0.28, 1, -0.05).normalize();
const SPIN_SPEED = 0.85; // rad/s
const HOVER_SCALE = 0.14;
const HOVER_GLOW = 0.5;

const GOLD = 0xf2c43d, GOLD_TIP = 0xfff0c0;
const GREY = 0x8d8d93, GREY_TIP = 0xc7c7cc; // "not your turn" disabled look

function buildChalk(): THREE.Group {
  const g = new THREE.Group();
  // A rough chalk stick: a stubby hexagonal prism, slightly tapered, laid on a
  // gentle diagonal. Low-poly + a couple of nicks read as "chalk" placeholder.
  const mat = new THREE.MeshStandardMaterial({
    color: GOLD, roughness: 0.62, metalness: 0.25, emissive: GOLD, emissiveIntensity: 0,
    flatShading: true,
  });
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 1.05, 6, 1), mat);
  stick.name = "chalkBody";
  // Lay it diagonally so the spin shows off its length.
  stick.rotation.set(0, 0, Math.PI * 0.32);
  g.add(stick);
  // A worn, lighter tip on one end.
  const tip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.17, 0.18, 6, 1),
    new THREE.MeshStandardMaterial({ color: GOLD_TIP, roughness: 0.5, metalness: 0.1, flatShading: true })
  );
  tip.name = "chalkTip";
  tip.position.set(Math.cos(Math.PI * 0.82) * 0.55, Math.sin(Math.PI * 0.82) * 0.55, 0);
  tip.rotation.set(0, 0, Math.PI * 0.32);
  g.add(tip);
  // Tiny chalk-dust nicks for a rough silhouette.
  for (let i = 0; i < 3; i++) {
    const nick = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.08, 0.08),
      mat
    );
    const a = Math.PI * 0.32, t = (i - 1) * 0.3;
    nick.position.set(Math.cos(a + Math.PI / 2) * 0.16 + Math.cos(a) * t, Math.sin(a + Math.PI / 2) * 0.16 + Math.sin(a) * t, 0.12);
    g.add(nick);
  }
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
  const tipMat = (spinner.getObjectByName("chalkTip") as THREE.Mesh).material as THREE.MeshStandardMaterial;

  let visible = false;
  let active = true; // gold + interactive; false = greyed "not your turn"
  let spin = 0;
  let hover = false;
  let hoverAmt = 0;

  const applyTint = () => {
    bodyMat.color.setHex(active ? GOLD : GREY);
    bodyMat.emissive.setHex(active ? GOLD : 0x000000);
    tipMat.color.setHex(active ? GOLD_TIP : GREY_TIP);
  };

  const local = new THREE.Matrix4();
  const idq = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const update = (dt: number) => {
    group.visible = visible;
    if (visible) {
      hoverAmt += ((hover ? 1 : 0) - hoverAmt) * Math.min(1, dt * 12);
      const eff = active ? hoverAmt : 0; // greyed chalk never scales/glows
      bodyMat.emissiveIntensity = HOVER_GLOW * eff;
      const s = IDLE.scale * (1 + HOVER_SCALE * eff);
      spin += dt * SPIN_SPEED;
      spinner.quaternion.setFromAxisAngle(SPIN_AXIS, spin);
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
