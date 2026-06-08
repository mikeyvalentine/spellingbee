import * as THREE from "three";

// 3D tomato power-up. An idle tomato sits in the lower-right corner of the view
// (anchored to the camera) and spins slowly on a tilted axis to read as an
// active item. Throwing launches a tomato that arcs toward the chalkboard; when
// it lands the caller swaps in the splat. Placeholder geometry — swap
// buildTomato() for a loaded .glb later (keep the same ~1-unit size).

export interface TomatoView {
  group: THREE.Group; // idle corner tomato (add to scene)
  setVisible(v: boolean): void;
  update(dt: number): void; // anchor + spin idle; advance flights
  hitTest(ndcX: number, ndcY: number): boolean; // pointer over the idle tomato
  cornerWorldPos(out: THREE.Vector3): THREE.Vector3; // idle tomato's world position
  /** Launch a tomato arcing from -> to (world space); onLand fires at the end. */
  launch(from: THREE.Vector3, to: THREE.Vector3, onLand: () => void): void;
}

// Idle pose in camera space (-Z forward). Lower-right corner. Tuned by eye.
const IDLE = { pos: new THREE.Vector3(0.66, -0.46, -1.35), scale: 0.32 };
const SPIN_AXIS = new THREE.Vector3(0.32, 1, 0.06).normalize();
const SPIN_SPEED = 0.9; // rad/s
const FLIGHT_MS = 413; // throw speed (was 620 — 1.5x faster)

function buildTomato(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 28, 20),
    new THREE.MeshStandardMaterial({ color: 0xd62b1f, roughness: 0.42, metalness: 0.0 })
  );
  body.scale.set(1, 0.86, 1); // slightly squashed, tomato-ish
  g.add(body);
  // Calyx (green star) + little stem on top.
  const green = new THREE.MeshStandardMaterial({ color: 0x4f8f37, roughness: 0.7 });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.16, 8), green);
  stem.position.set(0, 0.5, 0);
  g.add(stem);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 4), green);
    leaf.position.set(Math.cos(a) * 0.13, 0.42, Math.sin(a) * 0.13);
    leaf.rotation.set(Math.PI * 0.42, 0, -a + Math.PI / 2);
    leaf.scale.set(1, 1, 0.45);
    g.add(leaf);
  }
  // Soft highlight so the spin is visible.
  const hl = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff9c8e, transparent: true, opacity: 0.45 })
  );
  hl.position.set(-0.17, 0.17, 0.37);
  g.add(hl);
  g.renderOrder = 998;
  g.traverse((o) => { (o as THREE.Mesh).renderOrder = 998; });
  return g;
}

interface Flight {
  mesh: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  arc: number;
  t: number;
  onLand: () => void;
}

const easeIn = (p: number) => p * p;

export function makeTomato(camera: THREE.PerspectiveCamera, scene: THREE.Scene): TomatoView {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const spinner = buildTomato();
  group.add(spinner);
  scene.add(group);

  let visible = false;
  let spin = 0;
  const flights: Flight[] = [];

  const local = new THREE.Matrix4();
  const id = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const update = (dt: number) => {
    group.visible = visible;
    if (visible) {
      spin += dt * SPIN_SPEED;
      spinner.quaternion.setFromAxisAngle(SPIN_AXIS, spin);
      camera.updateMatrixWorld();
      local.compose(IDLE.pos, id, sc.set(IDLE.scale, IDLE.scale, IDLE.scale));
      group.matrix.multiplyMatrices(camera.matrixWorld, local);
      group.matrixWorldNeedsUpdate = true;
    }
    // advance flights
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.t += (dt * 1000) / FLIGHT_MS;
      const p = Math.min(1, f.t);
      f.mesh.position.lerpVectors(f.from, f.to, easeIn(p));
      f.mesh.position.y += Math.sin(p * Math.PI) * f.arc; // parabolic lift
      f.mesh.rotateOnAxis(SPIN_AXIS, dt * 9); // fast tumble in flight
      const s = 0.32 * (1 - 0.45 * p); // shrink slightly as it lands
      f.mesh.scale.setScalar(s);
      if (p >= 1) {
        scene.remove(f.mesh);
        flights.splice(i, 1);
        f.onLand();
      }
    }
  };

  return {
    group,
    setVisible: (v) => { visible = v; },
    update,
    hitTest: (x, y) => {
      if (!visible) return false;
      ndc.set(x, y);
      ray.setFromCamera(ndc, camera);
      return ray.intersectObject(group, true).length > 0;
    },
    cornerWorldPos: (out) => {
      camera.updateMatrixWorld();
      return out.copy(IDLE.pos).applyMatrix4(camera.matrixWorld);
    },
    launch: (from, to, onLand) => {
      const mesh = buildTomato();
      mesh.position.copy(from);
      mesh.scale.setScalar(0.32);
      scene.add(mesh);
      flights.push({ mesh, from: from.clone(), to: to.clone(), arc: from.distanceTo(to) * 0.17, t: 0, onLand });
    },
  };
}
