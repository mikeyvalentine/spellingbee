import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// The 3D environment, driven by public/assets/classroom.glb. Named markers:
//   lobby                      camera = the lobby view (looks back at the class)
//   player, player.1 .. .7     per-seat cameras; players are seated here by join
//                              order, and `player` is the fixed match camera POV
//   currentturnplayerposition  where the active speller stands (hidden in-game)
//   doorwindow_arealight       plane on the -X wall → rect-area light (pos+size+normal)
//   front wall                 the board wall; the chalk-text plane mounts onto it
// Punctual lights aren't exported, so the two ceiling point lights are synthesized.

const GLB_URL = "/assets/classroom.glb";

// Fallbacks if a marker can't be found after import.
const FALLBACK_WINDOW = new THREE.Vector3(-5.12, 3.09, 2.71);
// Speller stand spot — tuned in the debug panel (overrides the marker, which is
// only used to hide its mesh). Re-tune with the panel's Copy values if needed.
const SPELLER_POS = new THREE.Vector3(3.7, 0.9, 6.7);
// Per-chair fine-tune offsets (tuned via the right-side debug panel), indexed
// by join-order seat. Extra seats beyond this list default to zero.
const SEAT_OFFSETS: [number, number, number][] = [
  [0, -0.35, 0],
  [-0.15, 0.1, 0.2],
  [-0.45, -0.05, 0.2],
  [0.45, -0.05, 0.2],
  [0.15, -0.2, 0],
  [-0.15, -0.2, 0],
  [0, 0.1, 0],
  [0, 0.1, 0],
];
const BOARD_W = 4.4;
const BOARD_H = 2.0;

export interface CameraPose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  fov: number;
}

export interface Seat {
  pos: THREE.Vector3; // floor position under the seat camera
  yaw: number; // facing (toward the board / where the camera looks)
}

export interface RoomLights {
  front: THREE.PointLight;
  back?: THREE.PointLight;
  window?: THREE.RectAreaLight;
}

export interface Classroom {
  root: THREE.Object3D;
  lobbyCam: CameraPose; // view while in the lobby
  matchCam: CameraPose; // fixed front view during a match
  seats: Seat[]; // per-player seating, indexed by join order
  seatOffset: THREE.Vector3; // mutable offset applied to all seated avatars (debug)
  seatOffsets: THREE.Vector3[]; // per-seat fine-tune offset, indexed like seats (debug)
  spellerPos: THREE.Vector3; // where the active speller stands
  spellerScale: number; // mutable speller avatar scale (debug-tunable)
  lights: RoomLights;
  boardMesh: THREE.Object3D; // the chalk-text plane (for pinning the Replay button)
  setBoardGuess(typed: string, length: number): void;
  setBoardResult(word: string, correct: boolean): void;
  clearBoard(length: number): void;
  setBoardHeader(text: string, accent?: { text: string; color: string } | null): void;
}

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export async function loadClassroom(scene: THREE.Scene): Promise<Classroom> {
  const board = makeChalkboard();
  let layout: ClassroomLayout;
  try {
    const gltf = await new GLTFLoader().loadAsync(GLB_URL);
    layout = buildFromGlb(gltf.scene, board);
  } catch (e) {
    console.warn("classroom.glb not loaded, using procedural fallback:", e);
    layout = buildProcedural(board);
  }
  layout.root.visible = false;
  scene.add(layout.root);

  return {
    root: layout.root,
    lobbyCam: layout.lobbyCam,
    matchCam: layout.matchCam,
    seats: layout.seats,
    seatOffsets: layout.seats.map((_, i) => new THREE.Vector3(...(SEAT_OFFSETS[i] ?? [0, 0, 0]))),
    seatOffset: new THREE.Vector3(0, 1, -0.3), // tuned via the debug panel
    spellerPos: layout.spellerPos,
    spellerScale: 1,
    lights: layout.lights,
    boardMesh: board.mesh,
    setBoardGuess: board.setGuess,
    setBoardResult: board.setResult,
    clearBoard: board.clear,
    setBoardHeader: board.setHeader,
  };
}

interface ClassroomLayout {
  root: THREE.Object3D;
  lobbyCam: CameraPose;
  matchCam: CameraPose;
  seats: Seat[];
  spellerPos: THREE.Vector3;
  lights: RoomLights;
}

// ---------------------------------------------------------------------------
// GLB classroom.
// ---------------------------------------------------------------------------
function buildFromGlb(root: THREE.Object3D, board: Chalkboard): ClassroomLayout {
  root.updateMatrixWorld(true);

  const cams = new Map<string, THREE.PerspectiveCamera>();
  const objs = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if ((o as THREE.PerspectiveCamera).isPerspectiveCamera) {
      cams.set(norm(o.name), o as THREE.PerspectiveCamera);
    }
    const n = norm(o.name);
    if (n && !objs.has(n)) objs.set(n, o);
  });

  // Shadows: room meshes only receive (casting from every mesh would make the
  // point-light shadow pass far too expensive). Ceiling is double-sided.
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    const n = norm(o.name);
    if (n.includes("ceiling") || n.includes("roof")) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) if (m) (m as THREE.Material).side = THREE.DoubleSide;
    }
  });

  // Hide marker meshes that shouldn't render in-game.
  for (const key of ["currentturnplayerposition", "doorwindowarealight", "sphere"]) {
    const o = objs.get(key);
    if (o) o.visible = false;
  }

  const poseOf = (cam?: THREE.PerspectiveCamera, fallback?: CameraPose): CameraPose => {
    if (!cam) return fallback ?? { pos: new THREE.Vector3(0, 2, 0), quat: new THREE.Quaternion(), fov: 50 };
    return {
      pos: cam.getWorldPosition(new THREE.Vector3()),
      quat: cam.getWorldQuaternion(new THREE.Quaternion()),
      fov: cam.fov,
    };
  };
  const seatOf = (cam: THREE.PerspectiveCamera): Seat => {
    const pos = cam.getWorldPosition(new THREE.Vector3());
    const q = cam.getWorldQuaternion(new THREE.Quaternion());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return { pos: new THREE.Vector3(pos.x, 0, pos.z), yaw: Math.atan2(fwd.x, fwd.z) };
  };

  // Seat cameras: player, player.1 .. player.7  (index by numeric suffix).
  const seatCams: THREE.PerspectiveCamera[] = [];
  for (const [n, cam] of cams) {
    const m = n.match(/^player(\d*)$/);
    if (m) seatCams[m[1] === "" ? 0 : parseInt(m[1])] = cam;
  }
  const present = seatCams.filter(Boolean);
  const seats = present.map(seatOf);
  const matchCam = poseOf(present[0]);
  const lobbyCam = poseOf(cams.get("lobby"), matchCam);

  const spellerPos = SPELLER_POS.clone();

  const lights = buildLights(root, objs);

  // Chalk-text plane auto-mounted onto the front wall, facing the class (-Z).
  mountBoard(root, objs.get("frontwall"), board);

  return { root, lobbyCam, matchCam, seats, spellerPos, lights };
}

function buildLights(root: THREE.Object3D, objs: Map<string, THREE.Object3D>): RoomLights {
  // Two warm ceiling point lights, derived from the ceiling's bounds (the GLB
  // exports no punctual light data). Front one (over the speller) casts shadow.
  const ceiling = objs.get("ceiling");
  let pf = new THREE.Vector3(0.5, 5.4, 4);
  let pb = new THREE.Vector3(0.5, 5.4, -2);
  if (ceiling) {
    const b = new THREE.Box3().setFromObject(ceiling);
    const y = b.max.y - 0.5;
    const cx = (b.min.x + b.max.x) / 2;
    pf = new THREE.Vector3(cx, y, THREE.MathUtils.lerp(b.min.z, b.max.z, 0.72));
    pb = new THREE.Vector3(cx, y, THREE.MathUtils.lerp(b.min.z, b.max.z, 0.28));
  }

  const front = new THREE.PointLight(0xffe6bc, 26, 10, 1.55); // tuned via debug
  front.position.copy(pf);
  front.castShadow = true;
  front.shadow.mapSize.set(512, 512);
  front.shadow.camera.near = 0.3;
  front.shadow.camera.far = 30;
  front.shadow.bias = -0.0006;
  root.add(front);

  const back = new THREE.PointLight(0xffe6bc, 16, 4, 1.6); // tuned via debug
  back.position.copy(pb);
  root.add(back);

  // Window: rect-area light from the doorwindow_arealight plane — read its
  // world position, size, and normal so it points into the room.
  const win = buildWindowLight(objs.get("doorwindowarealight"));
  root.add(win);

  return { front, back, window: win };
}

function buildWindowLight(plane?: THREE.Object3D): THREE.RectAreaLight {
  let center = FALLBACK_WINDOW.clone();
  let width = 3.5;
  let height = 3.0;
  let normal = new THREE.Vector3(1, 0, 0); // default: +X into the room

  if (plane) {
    const box = new THREE.Box3().setFromObject(plane);
    center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // The plane is thin along its normal axis; the other two axes are w/h.
    const axes: [string, number][] = [["x", size.x], ["y", size.y], ["z", size.z]];
    axes.sort((a, b) => a[1] - b[1]);
    const normalAxis = axes[0][0]; // smallest extent = normal direction
    const dims = axes.slice(1).map((a) => a[1]);
    width = Math.max(...dims);
    height = Math.min(...dims);
    normal = new THREE.Vector3(
      normalAxis === "x" ? 1 : 0,
      normalAxis === "y" ? 1 : 0,
      normalAxis === "z" ? 1 : 0
    );
    // Point the normal toward the room interior (origin-ish).
    const toCenter = new THREE.Vector3(0.5, center.y, -1).sub(center);
    if (normal.dot(toCenter) < 0) normal.negate();
  }

  const light = new THREE.RectAreaLight(0xe9e2d2, 7.5, width, height); // tuned via debug (warm)
  light.position.copy(center);
  light.lookAt(center.clone().add(normal)); // -Z faces the normal → into the room
  return light;
}

function mountBoard(root: THREE.Object3D, frontWall: THREE.Object3D | undefined, board: Chalkboard) {
  // Find the actual chalkboard panel: a flat mesh in the front of the room that
  // protrudes furthest into it (i.e. the board mounted on the front wall).
  let best: { c: THREE.Vector3; size: THREE.Vector3; minZ: number } | null = null;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const n = norm(o.name);
    if (/wall|floor|ceiling|window|door|light|player|sphere|current/.test(n)) return;
    const b = new THREE.Box3().setFromObject(mesh);
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    if (c.z < 3 || c.y < 1 || c.y > 5) return; // front-of-room, board height band
    if (size.x < 1.2 || size.y < 0.6 || size.z > 0.7) return; // wide, tall, flat
    if (!best || b.min.z < best.minZ) best = { c, size, minZ: b.min.z };
  });

  let cx = 0.5, cy = 2.8, z = 8.34, w = BOARD_W, h = BOARD_H;
  if (best) {
    const fit = best as { c: THREE.Vector3; size: THREE.Vector3; minZ: number };
    cx = fit.c.x;
    cy = fit.c.y;
    z = fit.minZ - 0.02; // just in front of the board's room-facing surface
    w = Math.min(fit.size.x * 0.9, 6);
    h = Math.min(fit.size.y * 0.82, 3);
  } else if (frontWall) {
    const b = new THREE.Box3().setFromObject(frontWall);
    cx = (b.min.x + b.max.x) / 2;
    z = b.min.z - 0.05;
  }
  board.mesh.scale.set(w / BOARD_W, h / BOARD_H, 1);
  board.mesh.position.set(cx, cy, z);
  board.mesh.rotation.y = Math.PI; // face -Z, toward the seated class
  root.add(board.mesh);
}

// ---------------------------------------------------------------------------
// Procedural fallback (only if classroom.glb is missing).
// ---------------------------------------------------------------------------
function buildProcedural(board: Chalkboard): ClassroomLayout {
  const root = new THREE.Group();
  root.name = "ClassroomProcedural";

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x6f5b43, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 8),
    new THREE.MeshStandardMaterial({ color: 0xbfae8e, roughness: 1 })
  );
  wall.position.set(0, 4, 8.4);
  wall.rotation.y = Math.PI;
  root.add(wall);

  const light = new THREE.PointLight(0xffe6bc, 60, 40, 1.4);
  light.position.set(0, 5.5, 4);
  light.castShadow = true;
  root.add(light);

  board.mesh.position.set(0, 2.8, 8.34);
  board.mesh.rotation.y = Math.PI;
  root.add(board.mesh);

  const mk = (p: THREE.Vector3, target: THREE.Vector3): CameraPose => {
    const o = new THREE.Object3D();
    o.position.copy(p);
    o.lookAt(target);
    return { pos: p, quat: o.quaternion.clone(), fov: 47.5 };
  };
  const matchCam = mk(new THREE.Vector3(0, 2, 0.5), new THREE.Vector3(0, 1.6, 8));
  const lobbyCam = mk(new THREE.Vector3(0, 2.4, 4), new THREE.Vector3(0, 1.6, -2));
  const seats: Seat[] = [];
  for (let i = 0; i < 8; i++) {
    const x = ((i % 4) - 1.5) * 1.6;
    const z = i < 4 ? 0.5 : -1.2;
    seats.push({ pos: new THREE.Vector3(x, 0, z), yaw: 0 });
  }

  return { root, lobbyCam, matchCam, seats, spellerPos: new THREE.Vector3(0, 0, 6), lights: { front: light } };
}

// ---------------------------------------------------------------------------
// Chalkboard: a plane whose texture is a <canvas> redrawn as the speller types.
// ---------------------------------------------------------------------------
interface HeaderAccent {
  text: string;
  color: string;
}
interface Chalkboard {
  mesh: THREE.Mesh;
  setGuess(typed: string, length: number): void;
  setResult(word: string, correct: boolean): void;
  clear(length: number): void;
  setHeader(text: string, accent?: HeaderAccent | null): void;
}

function makeChalkboard(): Chalkboard {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARD_W, BOARD_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
  mesh.name = "ChalkboardText";

  // DINAMO ABC Stefan Simple (trial) — registered via @font-face in index.html.
  const FONT = "'ABC Stefan Simple', system-ui, sans-serif";
  let header = "";
  let headerAccent: HeaderAccent | null = null; // colored tier word (e.g. MEDIUM in yellow)
  let lastRender = () => {};

  const drawBase = () => {
    // Transparent — the GLB's own chalkboard shows through; we only draw chalk.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!header) return;
    ctx.font = `600 46px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 5;
    const accText = headerAccent ? ` · ${headerAccent.text}` : "";
    const mainW = ctx.measureText(header).width;
    const accW = accText ? ctx.measureText(accText).width : 0;
    const x = (canvas.width - (mainW + accW)) / 2;
    ctx.fillStyle = "rgba(244,241,232,0.82)";
    ctx.fillText(header, x, 70);
    if (headerAccent) {
      ctx.fillStyle = headerAccent.color;
      ctx.fillText(accText, x + mainW, 70);
    }
    ctx.shadowBlur = 0;
  };

  const drawCells = (cells: string[], color: string) => {
    const n = Math.max(cells.length, 1);
    const cellW = Math.min(120, 900 / n);
    const fontSize = Math.min(150, cellW * 1.3);
    const startX = canvas.width / 2 - (cellW * n) / 2 + cellW / 2;
    const y = canvas.height / 2 + 45;
    ctx.font = `700 ${fontSize}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 6;
    cells.forEach((ch, i) => ctx.fillText(ch, startX + i * cellW, y));
    ctx.shadowBlur = 0;
  };

  const setGuess = (typed: string, length: number) => {
    lastRender = () => {
      drawBase();
      const t = typed.toUpperCase().slice(0, length);
      const cells: string[] = [];
      for (let i = 0; i < length; i++) cells.push(t[i] ?? "_");
      drawCells(cells, "#f4f1e8");
      tex.needsUpdate = true;
    };
    lastRender();
  };

  const setResult = (word: string, correct: boolean) => {
    lastRender = () => {
      drawBase();
      drawCells(word.toUpperCase().split(""), correct ? "#9ff58a" : "#ff8a8a");
      tex.needsUpdate = true;
    };
    lastRender();
  };

  const clear = (length: number) => setGuess("", length);
  const setHeader = (text: string, accent: HeaderAccent | null = null) => {
    header = text;
    headerAccent = accent;
    lastRender();
  };

  setGuess("", 0);
  if (document.fonts) {
    document.fonts.load(`700 100px ${FONT}`).then(() => lastRender()).catch(() => {});
    document.fonts.ready.then(() => lastRender()).catch(() => {});
  }

  return { mesh, setGuess, setResult, clear, setHeader };
}
