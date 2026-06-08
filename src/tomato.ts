import * as THREE from "three";

// Tomato throw effect. The idle item UI is now a 2D DOM menu (see index.html /
// bee.ts); this module only owns the in-flight 3D tomato that arcs from the menu
// (or the thrower's avatar) toward the chalkboard so everyone sees the throw
// before the splat lands.

export interface TomatoFlights {
  update(dt: number): void; // advance any in-flight tomatoes
  launch(from: THREE.Vector3, to: THREE.Vector3, onLand: () => void): void;
  menuWorldPos(out: THREE.Vector3): THREE.Vector3; // world point near the lower-right item menu
}

const FLIGHT_MS = 413; // throw speed
const FLY_SCALE = 0.21;
const SPIN_AXIS = new THREE.Vector3(0.32, 1, 0.06).normalize();
// Camera-space anchor roughly over the lower-right item menu (flight source).
const MENU_LOCAL = new THREE.Vector3(0.52, -0.42, -1.2);

function buildTomato(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0xd62b1f, roughness: 0.42, metalness: 0.0 })
  );
  body.scale.set(1, 0.86, 1);
  g.add(body);
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

export function makeTomatoFlights(camera: THREE.PerspectiveCamera, scene: THREE.Scene): TomatoFlights {
  const flights: Flight[] = [];

  const update = (dt: number) => {
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.t += (dt * 1000) / FLIGHT_MS;
      const p = Math.min(1, f.t);
      f.mesh.position.lerpVectors(f.from, f.to, easeIn(p));
      f.mesh.position.y += Math.sin(p * Math.PI) * f.arc; // parabolic lift
      f.mesh.rotateOnAxis(SPIN_AXIS, dt * 9); // fast tumble in flight
      f.mesh.scale.setScalar(FLY_SCALE * (1 - 0.45 * p)); // shrink slightly as it lands
      if (p >= 1) {
        scene.remove(f.mesh);
        flights.splice(i, 1);
        f.onLand();
      }
    }
  };

  return {
    update,
    launch: (from, to, onLand) => {
      const mesh = buildTomato();
      mesh.position.copy(from);
      mesh.scale.setScalar(FLY_SCALE);
      scene.add(mesh);
      flights.push({ mesh, from: from.clone(), to: to.clone(), arc: from.distanceTo(to) * 0.17, t: 0, onLand });
    },
    menuWorldPos: (out) => {
      camera.updateMatrixWorld();
      return out.copy(MENU_LOCAL).applyMatrix4(camera.matrixWorld);
    },
  };
}
