import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

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
// Secondary (stats) board base plane — portrait, matching its 512×680 canvas.
const STATS_W = 2.4;
const STATS_H = 3.2;

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
  window?: THREE.RectAreaLight | THREE.PointLight; // PointLight on mobile (cheap)
  spot?: THREE.SpotLight; // warm stage spotlight on the active speller (vibe pass)
  accents?: THREE.Light[]; // extra colored/fill accent lights (vibe pass)
}

export interface Classroom {
  root: THREE.Object3D;
  lobbyCam: CameraPose; // view while in the lobby
  matchCam: CameraPose; // fixed front view during a match
  seats: Seat[]; // per-player seating, indexed by join order
  seatCams: CameraPose[]; // per-seat POV camera poses ('player', 'player.1' …), indexed like seats
  hostSpot: Seat; // where the host stands in the lobby (the lobby-camera spot, facing the class)
  seatOffset: THREE.Vector3; // mutable offset applied to all seated avatars (debug)
  seatOffsets: THREE.Vector3[]; // per-seat fine-tune offset, indexed like seats (debug)
  spellerPos: THREE.Vector3; // where the active speller stands
  spellerScale: number; // mutable speller avatar scale (debug-tunable)
  lights: RoomLights;
  boardMesh: THREE.Object3D; // the chalk-text plane (for pinning the Replay button)
  setBoardGuess(typed: string, length: number): void;
  setBoardResult(guess: string, correct: boolean, answer: string): void;
  clearBoard(length: number): void;
  setBoardHeader(text: string, accent?: { text: string; color: string } | null): void;
  /** Per-player stats on the secondary (left) board: name, WPM, accuracy %.
   *  `mine` = the name is the viewing client's own player (gets the yellow pill). */
  setStats(name: string, wpm: number, accuracy: number, mine: boolean): void;
  clearStats(): void;
  /** Write both boards' current content in, one char at a time (turn start). */
  revealBoards(): void;
  /** Erase both boards, one char at a time (during the result pause). */
  hideBoards(onDone?: () => void): void;
  /** Throw a tomato: animated splat covering all but the last 2 letters. */
  splatTomato(durationMs: number): void;
  /** Cancel any active tomato splat. */
  clearSplat(): void;
  /** Game-over screen on the main board: a title with an optional subtitle. */
  setEndScreen(title: string, subtitle: string): void;
  /** Golden chalk: reveal a letter at `index` in gold (crossfades from whatever was there). */
  revealLetter(index: number, letter: string): void;
  /** Clear all golden-chalk reveals + the aim oval (turn boundary). */
  clearReveals(): void;
  /** Highlight the letter slot the chalk is aiming at (-1 clears the oval). */
  setBoardAim(index: number): void;
  /** Pulse an oval on every letter slot (the chalk's "pick any letter" state). */
  setBoardAimAll(): void;
  /** Hit-test a pointer (NDC) against the board's letter slots; returns index or -1. */
  boardSlotAt(ndcX: number, ndcY: number, camera: THREE.Camera): number;
  /** Enable the blinking awaiting-"_" cursor (only on the local speller's POV). */
  setBoardCursorEnabled(on: boolean): void;
  /** Start the under-word turn countdown bar (depletes + reddens over durationMs). */
  setBoardTimer(durationMs: number): void;
  /** Clear the countdown bar. */
  clearBoardTimer(): void;
}

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export async function loadClassroom(scene: THREE.Scene): Promise<Classroom> {
  const board = makeChalkboard();
  const stats = makeStatsBoard();
  let layout: ClassroomLayout;
  try {
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(GLB_URL);
    layout = buildFromGlb(gltf.scene, board, stats);
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
    seatCams: layout.seatCams,
    hostSpot: layout.hostSpot,
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
    setStats: stats.setStats,
    clearStats: stats.clear,
    revealBoards: () => {
      // Only the word cells write in; the header + stats board appear instantly.
      board.writeIn();
    },
    hideBoards: (onDone) => {
      board.eraseOut(onDone);
    },
    splatTomato: board.splatTomato,
    clearSplat: board.clearSplat,
    setEndScreen: board.setEnd,
    revealLetter: board.revealLetter,
    clearReveals: board.clearReveals,
    setBoardCursorEnabled: board.setCursorEnabled,
    setBoardTimer: board.setTimer,
    clearBoardTimer: board.clearTimer,
    setBoardAim: board.setAim,
    setBoardAimAll: board.setAimAll,
    boardSlotAt: (ndcX, ndcY, cam) => {
      cam.updateMatrixWorld(); // fresh camera transform at tap time
      board.mesh.updateWorldMatrix(true, false);
      boardRay.setFromCamera(boardNdc.set(ndcX, ndcY), cam);
      const hit = boardRay.intersectObject(board.mesh, false)[0];
      if (!hit || !hit.uv) return -1;
      return board.slotAtUV(hit.uv.x, hit.uv.y);
    },
  };
}

// Shared raycaster for board slot hit-testing (golden chalk aim).
const boardRay = new THREE.Raycaster();
const boardNdc = new THREE.Vector2();

interface ClassroomLayout {
  root: THREE.Object3D;
  lobbyCam: CameraPose;
  matchCam: CameraPose;
  seats: Seat[];
  seatCams: CameraPose[];
  hostSpot: Seat;
  spellerPos: THREE.Vector3;
  lights: RoomLights;
}

// ---------------------------------------------------------------------------
// GLB classroom.
// ---------------------------------------------------------------------------
function buildFromGlb(root: THREE.Object3D, board: Chalkboard, stats: StatsBoard): ClassroomLayout {
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
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (n.includes("ceiling") || n.includes("roof")) {
      for (const m of mats) if (m) (m as THREE.Material).side = THREE.DoubleSide;
    }
    // The desk lamp's glossy metal throws a sharp specular hotspot that the bloom
    // pass blows out into a weird flare. Roughen + de-metal it (and cap any
    // emissive) so its highlight stays under the bloom threshold.
    if (n.includes("lamp")) {
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm || !sm.isMeshStandardMaterial) continue;
        sm.metalness = Math.min(sm.metalness ?? 1, 0.15);
        sm.roughness = Math.max(sm.roughness ?? 0.5, 0.72);
        sm.envMapIntensity = Math.min(sm.envMapIntensity ?? 1, 0.3);
        if (sm.emissiveIntensity) sm.emissiveIntensity = Math.min(sm.emissiveIntensity, 0.4);
        sm.needsUpdate = true;
      }
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
  const seatPoses = present.map((c) => poseOf(c)); // full per-seat POVs (lobby free-look)
  const matchCam = poseOf(present[0]);
  const lobbyCam = poseOf(cams.get("lobby"), matchCam);
  lobbyCam.fov = matchCam.fov; // host POV uses the same FOV as the seat cameras
  // The host stands at the lobby camera — the "teacher spot" — facing the class.
  const lobbyCamObj = cams.get("lobby");
  const hostSpot = lobbyCamObj
    ? seatOf(lobbyCamObj)
    : {
        pos: new THREE.Vector3(lobbyCam.pos.x, 0, lobbyCam.pos.z),
        yaw: (() => {
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(lobbyCam.quat);
          return Math.atan2(fwd.x, fwd.z);
        })(),
      };

  const spellerPos = SPELLER_POS.clone();

  const lights = buildLights(root, objs);

  // Chalk-text plane auto-mounted onto the front wall, facing the class (-Z).
  const mainCx = mountBoard(root, objs.get("frontwall"), board);
  // Stats plane on the secondary (tall, narrow) board off to the side.
  mountStatsBoard(root, stats, mainCx);

  return { root, lobbyCam, matchCam, seats, seatCams: seatPoses, hostSpot, spellerPos, lights };
}

function buildLights(root: THREE.Object3D, objs: Map<string, THREE.Object3D>): RoomLights {
  // Two warm ceiling point lights, derived from the ceiling's bounds (the GLB
  // exports no punctual light data). Front one (over the speller) casts shadow.
  const ceiling = objs.get("ceiling");
  // Room bounds (from the ceiling mesh) place every light below; the fallbacks
  // cover a missing ceiling marker.
  let cx = 0.5, ceilY = 5.4, minX = -5, maxX = 6, minZ = -3, maxZ = 9;
  if (ceiling) {
    const b = new THREE.Box3().setFromObject(ceiling);
    ceilY = b.max.y - 0.5;
    cx = (b.min.x + b.max.x) / 2;
    minX = b.min.x; maxX = b.max.x; minZ = b.min.z; maxZ = b.max.z;
  }
  const pf = new THREE.Vector3(cx, ceilY, THREE.MathUtils.lerp(minZ, maxZ, 0.72));
  const pb = new THREE.Vector3(cx, ceilY, THREE.MathUtils.lerp(minZ, maxZ, 0.28));

  const front = new THREE.PointLight(0xffd9a3, 20, 10, 1.55); // amber, dimmed — golden-hour re-skin (was 0xffe6bc, 26)
  front.position.copy(pf);
  front.castShadow = true;
  front.shadow.mapSize.set(512, 512);
  front.shadow.camera.near = 0.3;
  front.shadow.camera.far = 30;
  front.shadow.bias = -0.0006;
  root.add(front);

  const back = new THREE.PointLight(0xffd9a3, 11, 4, 1.6); // amber, dimmed — golden-hour re-skin (was 0xffe6bc, 16)
  back.position.copy(pb);
  root.add(back);

  // Window: rect-area light from the doorwindow_arealight plane — read its
  // world position, size, and normal so it points into the room. On mobile the
  // RectAreaLight's LTC shader is too costly per-pixel, so use a cheap PointLight.
  const isMobile = window.matchMedia("(pointer: coarse)").matches;
  const win = buildWindowLight(objs.get("doorwindowarealight"), isMobile);
  root.add(win);

  // --- Vibe pass: a hero speller spotlight + (desktop) extra accent lights. -----
  // Hero spotlight: a warm cone on the active speller (always at SPELLER_POS). It
  // originates from the desk lamp — the "sphere" placeholder mesh marks the bulb
  // — so the lamp reads as the source. Enabled on BOTH platforms (one light); its
  // shadow is desktop-only since mobile runs shadow-less. Falls back to overhead.
  // Values dialed in live via the debug panel (intensity/distance/angle/penumbra/
  // decay) and baked here. Position + aim were tuned at the lamp head; the target
  // is the resolved point from the panel's yaw/pitch/reach.
  const spot = new THREE.SpotLight(0xffe1b0, 40, 4.5, 0.78, 0.88, 2.9);
  spot.position.set(4.22, 2.55, 4.94);
  spot.target.position.set(4.287, 2.136, 6.276);
  spot.castShadow = !isMobile;
  if (!isMobile) {
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0006;
  }
  root.add(spot);
  root.add(spot.target);

  // The remaining accent lights are extra forward lights; keep them desktop-only
  // (mobile already runs a lean lighting profile). The warm color re-skin still
  // applies on mobile. All tunable; intensities assume ACES + ~0.95 exposure.
  const accents: THREE.Light[] = [];
  if (!isMobile) {
    // Cool counter-fill from high on the window wall. The warm/cool contrast is
    // what makes the room read "moody" instead of flat.
    const coolFill = new THREE.PointLight(0x5b7dff, 8, 18, 1.4);
    coolFill.position.set(minX + 0.6, ceilY - 0.8, THREE.MathUtils.lerp(minZ, maxZ, 0.45));
    root.add(coolFill);
    accents.push(coolFill);

    // Soft warm wash on the chalkboard wall so the board pops — an even glow.
    const boardGlow = new THREE.PointLight(0xffb877, 6, 12, 1.4);
    boardGlow.position.set(cx, 4.0, maxZ - 1.6);
    root.add(boardGlow);
    accents.push(boardGlow);

    // Two dim, saturated color accents in the back corners — a subtle wash of
    // color around the room (kept low so it reads as ambiance, not a disco).
    const magenta = new THREE.PointLight(0xb14bff, 5, 10, 1.8);
    magenta.position.set(minX + 1.0, 1.6, minZ + 1.0);
    root.add(magenta);
    accents.push(magenta);

    const teal = new THREE.PointLight(0x18d3c8, 4.5, 10, 1.8);
    teal.position.set(maxX - 1.0, 1.6, minZ + 1.0);
    root.add(teal);
    accents.push(teal);
  }

  return { front, back, window: win, spot, accents };
}

function buildWindowLight(plane: THREE.Object3D | undefined, isMobile: boolean): THREE.RectAreaLight | THREE.PointLight {
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

  if (isMobile) {
    // Cheap stand-in: a warm PointLight just inside the window plane (golden-hour
    // re-skin: low warm sunset, matching the desktop RectAreaLight).
    const pl = new THREE.PointLight(0xffb070, 7, 12, 1.6);
    pl.position.copy(center).add(normal.clone().multiplyScalar(0.3));
    return pl;
  }
  const light = new THREE.RectAreaLight(0xffb070, 4.0, width, height); // low warm sunset — golden-hour re-skin (was 0xe9e2d2, 7.5)
  light.position.copy(center);
  light.lookAt(center.clone().add(normal)); // -Z faces the normal → into the room
  return light;
}

interface BoardFit {
  c: THREE.Vector3;
  size: THREE.Vector3;
  minZ: number;
}

// All flat, front-of-room board panels (wide enough to be a board, thin in z).
function boardPanels(root: THREE.Object3D): BoardFit[] {
  const out: BoardFit[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const n = norm(o.name);
    if (/wall|floor|ceiling|window|door|light|player|sphere|current|lamp/.test(n)) return;
    const b = new THREE.Box3().setFromObject(mesh);
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    if (c.z < 3 || c.y < 1 || c.y > 5.5) return; // front-of-room, board height band
    if (size.y < 0.6 || size.z > 0.7 || size.x < 0.6) return; // tall-ish, flat
    out.push({ c, size, minZ: b.min.z });
  });
  return out;
}

// Mounts the main chalk-text plane on the widest front board; returns its center x.
function mountBoard(root: THREE.Object3D, frontWall: THREE.Object3D | undefined, board: Chalkboard): number {
  const panels = boardPanels(root).filter((p) => p.size.x >= 1.2);
  let best: BoardFit | null = null;
  for (const p of panels) if (!best || p.minZ < best.minZ) best = p; // most protruding

  let cx = 0.5, cy = 2.8, z = 8.34, w = BOARD_W, h = BOARD_H;
  if (best) {
    cx = best.c.x;
    cy = best.c.y;
    z = best.minZ - 0.02;
    w = Math.min(best.size.x * 0.9, 6);
    h = Math.min(best.size.y * 0.82, 3);
  } else if (frontWall) {
    const b = new THREE.Box3().setFromObject(frontWall);
    cx = (b.min.x + b.max.x) / 2;
    z = b.min.z - 0.05;
  }
  board.mesh.scale.set(w / BOARD_W, h / BOARD_H, 1);
  board.mesh.position.set(cx, cy, z);
  board.mesh.rotation.y = Math.PI; // face -Z, toward the seated class
  root.add(board.mesh);
  return cx;
}

// Mounts the stats plane on the secondary (narrow) board off to the side of main.
function mountStatsBoard(root: THREE.Object3D, stats: StatsBoard, mainCx: number) {
  const side = boardPanels(root)
    .filter((p) => Math.abs(p.c.x - mainCx) > 2 && p.size.y > 1.8) // off to the side, tall
    .sort((a, b) => a.minZ - b.minZ)[0]; // most protruding panel there
  if (!side) {
    stats.mesh.visible = false; // no secondary board in this GLB
    return;
  }
  stats.mesh.scale.set((side.size.x * 0.86) / STATS_W, (side.size.y * 0.82) / STATS_H, 1);
  stats.mesh.position.set(side.c.x, side.c.y, side.minZ - 0.02);
  stats.mesh.rotation.y = Math.PI;
  root.add(stats.mesh);
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
  // Eye-height POV at each seat, looking toward the board wall.
  const seatCams = seats.map((s) =>
    mk(new THREE.Vector3(s.pos.x, 1.55, s.pos.z), new THREE.Vector3(s.pos.x * 0.4, 1.8, 8))
  );
  const hostSpot: Seat = { pos: new THREE.Vector3(0, 0, 4), yaw: Math.PI };

  return { root, lobbyCam, matchCam, seats, seatCams, hostSpot, spellerPos: new THREE.Vector3(0, 0, 6), lights: { front: light } };
}

// ---------------------------------------------------------------------------
// Chalkboard: a plane whose texture is a <canvas> redrawn as the speller types.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Animated chalk surface: a canvas/texture whose content "writes in" and
// "erases" one character at a time, in parallel across its lines.
// ---------------------------------------------------------------------------
const WRITE_MS = 60; // ms per character (write-in / erase pace)
const FONT = "'ABC Stefan Simple', system-ui, sans-serif";

interface Glyph {
  ch: string;
  x: number;
  y: number;
  font: string;
  color: string;
}
interface Line {
  glyphs: Glyph[];
  underlineY?: number;
  strikeY?: number; // horizontal line through the glyphs (wrong-answer strikethrough)
  noReveal?: boolean; // always fully shown — exempt from the write-in/erase reveal
  pill?: string; // solid rounded background behind the glyphs (the speller's name pill)
}

// Rounded-rect (pill) path.
function pillPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h / 2, w / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ---- tomato splat shape (a unit splatter, scaled to a half-width/height box) ----
interface SplatBlobs {
  main: { x: number; y: number; rx: number; ry: number; rot: number }[];
  drips: { x: number; len: number; r: number }[];
  seeds: { x: number; y: number; r: number }[];
}
const easeOutBack = (p: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
// Random splatter geometry, generated once per throw (so it doesn't flicker).
// Geometry is normalized so the shape's max reach is ~1.25 of half-W/H (lobes)
// and drips stay within ~1.3 of half-H below — the overlay uses those bounds to
// keep the whole splat inside the board.
function genSplatBlobs(): SplatBlobs {
  const main: SplatBlobs["main"] = [{ x: 0, y: 0, rx: 1.0, ry: 0.92, rot: 0 }]; // central mass covers the cells
  const lobes = 9 + Math.floor(Math.random() * 4);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const rad = 0.55 + Math.random() * 0.28; // center ≤ 0.83
    main.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad * 0.8, rx: 0.18 + Math.random() * 0.22, ry: 0.16 + Math.random() * 0.2, rot: Math.random() * Math.PI });
  }
  const drips: SplatBlobs["drips"] = [];
  const nd = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < nd; i++) drips.push({ x: (Math.random() * 2 - 1) * 0.66, len: 0.3 + Math.random() * 0.4, r: 0.06 + Math.random() * 0.05 });
  const seeds: SplatBlobs["seeds"] = [];
  for (let i = 0; i < 7; i++) seeds.push({ x: (Math.random() * 2 - 1) * 0.6, y: (Math.random() * 2 - 1) * 0.5, r: 0.05 + Math.random() * 0.04 });
  return { main, drips, seeds };
}
function drawSplatShape(c: CanvasRenderingContext2D, halfW: number, halfH: number, b: SplatBlobs) {
  c.fillStyle = "#b3231a"; // drips behind, dripping downward
  for (const d of b.drips) {
    const x = d.x * halfW;
    c.beginPath();
    c.ellipse(x, halfH * 0.5 + d.len * halfH * 0.5, d.r * halfW * 1.1, d.len * halfH, 0, 0, Math.PI * 2);
    c.fill();
    c.beginPath(); c.arc(x, halfH * 0.5 + d.len * halfH, d.r * halfW * 1.5, 0, Math.PI * 2); c.fill();
  }
  c.fillStyle = "#c5281d"; // main mass
  for (const m of b.main) {
    c.beginPath();
    c.ellipse(m.x * halfW, m.y * halfH, m.rx * halfW, m.ry * halfH, m.rot, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = "rgba(150,22,14,0.45)"; // darker centre for depth
  c.beginPath(); c.ellipse(0, 0, halfW * 0.55, halfH * 0.55, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = "rgba(86,12,6,0.7)"; // seeds
  for (const s of b.seeds) {
    c.beginPath(); c.ellipse(s.x * halfW, s.y * halfH, Math.max(2, s.r * halfW * 0.5), Math.max(3, s.r * halfH), 0.5, 0, Math.PI * 2); c.fill();
  }
}
interface Surface {
  tex: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  setLines(lines: Line[]): void; // set content, fully shown
  writeIn(onDone?: () => void): void;
  eraseOut(onDone?: () => void): void;
  /** Overlay drawn on top of the glyphs every frame (tomato splats + aim box). */
  setAfterDraw(fn: ((ctx: CanvasRenderingContext2D) => void) | null): void;
  redraw(): void;
}

function makeSurface(w: number, h: number): Surface {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  let lines: Line[] = [];
  let reveal = Infinity; // chars shown per line = min(reveal, line length)
  let raf = 0;
  let afterDraw: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  // Only revealable (non-noReveal) lines drive the write-in/erase length.
  const maxLen = () => lines.reduce((m, l) => (l.noReveal ? m : Math.max(m, l.glyphs.length)), 0);

  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const line of lines) {
      const n = line.noReveal ? line.glyphs.length : Math.min(reveal, line.glyphs.length);
      // Solid pill background behind the glyphs (the current speller's name).
      if (line.pill && n > 0) {
        let minX = Infinity, maxX = -Infinity, fs = 40;
        for (let i = 0; i < n; i++) {
          const g = line.glyphs[i];
          ctx.font = g.font;
          minX = Math.min(minX, g.x);
          maxX = Math.max(maxX, g.x + ctx.measureText(g.ch).width);
          const m = /(\d+(?:\.\d+)?)px/.exec(g.font);
          if (m) fs = parseFloat(m[1]);
        }
        const padX = fs * 0.55, padY = fs * 0.34;
        const px = minX - padX, pw = maxX - minX + padX * 2, ph = fs + padY * 2;
        const py = line.glyphs[0].y - ph / 2;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 3;
        pillPath(ctx, px, py, pw, ph, ph / 2);
        ctx.fillStyle = line.pill;
        ctx.fill();
        ctx.restore();
      }
      ctx.shadowColor = "rgba(0,0,0,0.4)";
      ctx.shadowBlur = 5;
      for (let i = 0; i < n; i++) {
        const g = line.glyphs[i];
        ctx.font = g.font;
        ctx.fillStyle = g.color;
        ctx.fillText(g.ch, g.x, g.y);
      }
      if (line.underlineY != null && n > 0) {
        const first = line.glyphs[0];
        const last = line.glyphs[n - 1];
        ctx.font = last.font;
        const endX = last.x + ctx.measureText(last.ch).width;
        ctx.shadowBlur = 0;
        ctx.strokeStyle = first.color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(first.x, line.underlineY);
        ctx.lineTo(endX, line.underlineY);
        ctx.stroke();
      }
      if (line.strikeY != null && n > 0) {
        const first = line.glyphs[0];
        const last = line.glyphs[n - 1];
        ctx.font = last.font;
        const endX = last.x + ctx.measureText(last.ch).width;
        ctx.shadowBlur = 0;
        ctx.strokeStyle = first.color;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(first.x, line.strikeY);
        ctx.lineTo(endX, line.strikeY);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    if (afterDraw) afterDraw(ctx);
    tex.needsUpdate = true;
  };

  const run = (from: number, to: number, onDone?: () => void) => {
    cancelAnimationFrame(raf);
    reveal = from;
    draw(); // render the start state NOW (prevents a 1-frame flash of full content)
    const dir = to >= from ? 1 : -1;
    let last = -1;
    let acc = 0;
    const tick = (now: number) => {
      if (last < 0) last = now;
      acc += now - last;
      last = now;
      while (acc >= WRITE_MS) {
        acc -= WRITE_MS;
        reveal += dir;
        if ((dir > 0 && reveal >= to) || (dir < 0 && reveal <= to)) {
          reveal = dir > 0 ? Infinity : 0; // writeIn -> show all (for live updates)
          draw();
          onDone?.();
          return;
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  return {
    tex,
    ctx,
    setLines(l) {
      lines = l;
      reveal = Infinity;
      cancelAnimationFrame(raf);
      draw();
    },
    writeIn(onDone) {
      run(0, maxLen(), onDone);
    },
    eraseOut(onDone) {
      run(maxLen(), 0, onDone);
    },
    setAfterDraw(fn) {
      afterDraw = fn;
      draw();
    },
    redraw: draw,
  };
}

// Lay out a horizontally-centered line of (possibly multi-colored) segments into
// per-character glyphs at their final positions.
function layoutCentered(
  ctx: CanvasRenderingContext2D,
  segments: { text: string; color: string; font: string }[],
  cx: number,
  y: number
): Glyph[] {
  let total = 0;
  for (const s of segments) {
    ctx.font = s.font;
    total += ctx.measureText(s.text).width;
  }
  let x = cx - total / 2;
  const glyphs: Glyph[] = [];
  for (const s of segments) {
    ctx.font = s.font;
    for (const ch of s.text) {
      glyphs.push({ ch, x, y, font: s.font, color: s.color });
      x += ctx.measureText(ch).width;
    }
  }
  return glyphs;
}

// ---------------------------------------------------------------------------
// Main chalkboard: header (ROUND X · TIER) + the word cells/letters.
// ---------------------------------------------------------------------------
interface HeaderAccent {
  text: string;
  color: string;
}
interface Chalkboard {
  mesh: THREE.Mesh;
  setGuess(typed: string, length: number): void;
  setResult(guess: string, correct: boolean, answer: string): void;
  clear(length: number): void;
  setHeader(text: string, accent?: HeaderAccent | null): void;
  writeIn(onDone?: () => void): void;
  eraseOut(onDone?: () => void): void;
  splatTomato(durationMs: number): void; // animated tomato splat
  clearSplat(): void;
  setEnd(title: string, subtitle: string): void; // game-over screen
  revealLetter(index: number, letter: string): void; // golden-chalk reveal
  clearReveals(): void;
  setAim(index: number): void; // -1 clears, >=0 pulses one slot
  setAimAll(): void; // pulse every slot ("pick any letter")
  slotAtUV(u: number, v: number): number; // board UV -> letter-slot index (-1 = none)
  setCursorEnabled(on: boolean): void; // blink the awaiting "_" (local speller only)
  setTimer(durationMs: number): void; // start the under-word countdown bar
  clearTimer(): void;
}

function makeChalkboard(): Chalkboard {
  const W = 1024, H = 512;
  const surf = makeSurface(W, H);
  const ctx = surf.ctx;
  const CHALK = "rgba(244,241,232,0.85)";
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARD_W, BOARD_H),
    new THREE.MeshBasicMaterial({ map: surf.tex, transparent: true })
  );
  mesh.name = "ChalkboardText";

  const GOLD = "#f2c43d";
  const REVEAL_FADE = 420; // ms for the gold reveal crossfade
  let header = "";
  let headerAccent: HeaderAccent | null = null;
  // Per-slot display chars ("_" for empty). The CALLER composes this positionally
  // (gold slots passed as "_"); the board colors gold slots from `reveals`.
  let cells: string[] = [];
  let wordLen = 0; // number of letter cells this turn
  // Golden-chalk reveals: slot index -> { gold letter, fade start, char it replaced }.
  const reveals = new Map<number, { letter: string; start: number; prev: string }>();
  // Chalk aim ovals: mode 0 = off, 1 = all slots, 2 = the single `aimIndex` slot.
  // While aiming, the oval(s) pulse (fade in/out) via aimTimer.
  let aimMode: 0 | 1 | 2 = 0;
  let aimIndex = -1;
  let aimTimer = 0;
  let revealRaf = 0;
  // Blinking text cursor on the slot awaiting input (leftmost empty, NON-gold slot).
  // Only enabled on the local speller's own POV (other clients see static cells).
  const BLINK_MS = 450; // medium blink
  let cursorEnabled = false;
  let cursorIdx = -1;
  let cursorOn = true;
  let blinkTimer = 0;
  // Turn countdown bar (under the word cells): depletes + reddens as time runs out.
  let timerStart = 0, timerDur = 0, timerRaf = 0;
  // Animated tomato splat (covers all but the last 2 letters — see splatTomato).
  let splat: { start: number; duration: number; revealMs: number; hideMs: number; cover: number; blobs: SplatBlobs } | null = null;
  let splatRaf = 0;
  let resultMode: { guess: string; correct: boolean; answer: string } | null = null;
  let endMode: { title: string; subtitle: string } | null = null;

  // Shared geometry for the word cells, so the glyph, the splat, the aim box, and
  // click hit-testing all line up exactly.
  const cellGeom = (n: number) => {
    const cellW = Math.min(120, 900 / n);
    const fontSize = Math.min(150, cellW * 1.3);
    const startX = W / 2 - (cellW * n) / 2;
    const yc = H / 2 + 45; // glyph vertical centre
    return { cellW, fontSize, startX, yc };
  };
  // Tomato splat overlay, drawn over the glyphs while active. Reveal grows it
  // width-wise (scaleX small->large); hide slides it down + fades it out.
  const drawSplatOverlay = (c: CanvasRenderingContext2D) => {
    if (!splat) return;
    const n = cells.length;
    if (n < 1) return;
    const t = performance.now() - splat.start;
    const { duration, revealMs, cover } = splat;
    const M = 16; // keep the whole splat inside the board with this margin
    const LOBE = 1.28;
    const { cellW, fontSize, startX, yc } = cellGeom(n);

    // Generously over-cover the glyph row (spans yc ± fontSize/2) so it can sit a
    // little high and slowly droop down without ever exposing the letters.
    let halfW = (cover * cellW) / 2 + cellW * 0.06;
    let halfH = fontSize * 0.85;
    const maxHalfW = (W - 2 * M) / (2 * LOBE * 1.08); // 1.08 leaves room for the reveal overshoot
    if (halfW > maxHalfW) { const f = maxHalfW / halfW; halfW = maxHalfW; halfH *= f; }
    const exX = halfW * LOBE, exBot = halfH * 1.2;

    const gh = fontSize * 0.5; // half the glyph height
    // Start high: bottom of the mass just covers the glyph bottom + a little pad.
    const startCenter = yc - (halfH - gh - fontSize * 0.12);
    // Slow droop, capped so the glyph TOP stays covered AND it stays in the board.
    const droopTotal = Math.max(0, Math.min(
      fontSize * 0.5,
      2 * halfH - 2 * gh - fontSize * 0.12, // keeps the top covered
      (H - M) - exBot - startCenter // stays within the board bottom
    ));

    let scaleX = 1, alpha = 1;
    if (t < revealMs) scaleX = Math.max(0.04, easeOutBack(t / revealMs)); // splatter spreads in
    // Constant crawl downward from the end of the reveal to the end of the splat.
    const dp = Math.max(0, Math.min(1, (t - revealMs) / Math.max(1, duration - revealMs)));
    const yDroop = dp * droopTotal;
    // Fade out only over the final stretch (still drooping while it fades).
    const fadeMs = Math.min(500, duration * 0.2);
    if (t > duration - fadeMs) alpha = Math.max(0, 1 - (t - (duration - fadeMs)) / fadeMs);

    const cx = Math.min(Math.max(startX + (cover * cellW) / 2, M + exX), W - M - exX);
    c.save();
    c.globalAlpha = alpha;
    c.translate(cx, startCenter + yDroop);
    c.scale(scaleX, 1);
    drawSplatShape(c, halfW, halfH, splat.blobs);
    c.restore();
  };

  // A row of glyphs in fixed word-cell columns (n cells, padded with "_"), at a
  // given baseline y + colour, optionally struck through.
  const wordCellsLine = (text: string, color: string, y: number, n: number, strike: boolean): Line => {
    const { cellW, fontSize, startX } = cellGeom(n);
    const font = `700 ${fontSize}px ${FONT}`;
    ctx.font = font;
    const glyphs: Glyph[] = [];
    for (let i = 0; i < n; i++) {
      const ch = text[i] ?? "_";
      glyphs.push({ ch, font, color, x: startX + i * cellW + cellW / 2 - ctx.measureText(ch).width / 2, y });
    }
    const line: Line = { glyphs };
    if (strike) line.strikeY = y;
    return line;
  };
  // The correct answer, smaller + centered, shown in chalk-white below a wrong guess.
  const answerLine = (text: string, y: number): Line => ({
    glyphs: layoutCentered(ctx, [{ text, color: CHALK, font: `600 60px ${FONT}` }], W / 2, y),
  });

  const rebuild = () => {
    const lines: Line[] = [];
    cursorIdx = -1; // recomputed below only in the live word-cell path
    if (endMode) {
      // Game-over screen: "GAME OVER" with the winner below (no header/cells).
      lines.push({ glyphs: layoutCentered(ctx, [{ text: endMode.title, color: CHALK, font: `700 96px ${FONT}` }], W / 2, 205), noReveal: true });
      if (endMode.subtitle) {
        lines.push({ glyphs: layoutCentered(ctx, [{ text: endMode.subtitle, color: CHALK, font: `600 54px ${FONT}` }], W / 2, 330), noReveal: true });
      }
      surf.setLines(lines);
      manageBlink();
      return;
    }
    if (header) {
      const segs = [{ text: header, color: CHALK, font: `600 46px ${FONT}` }];
      if (headerAccent) {
        segs.push({ text: ` · ${headerAccent.text}`, color: headerAccent.color, font: `600 46px ${FONT}` });
      }
      // Header shows instantly — only the word cells write in / erase out.
      lines.push({ glyphs: layoutCentered(ctx, segs, W / 2, 70), noReveal: true });
    }
    if (resultMode) {
      const ans = resultMode.answer.toUpperCase();
      if (resultMode.correct) {
        lines.push(wordCellsLine(ans, "#9ff58a", H / 2 + 45, ans.length || 1, false));
      } else {
        // Their spelling, struck through in red; the correct answer below in white.
        const g = (resultMode.guess || "").toUpperCase();
        const n = ans.length || g.length || 1;
        lines.push(wordCellsLine(g, "#ff8a8a", 222, n, true));
        lines.push(answerLine(ans, 372));
      }
    } else if (wordLen > 0) {
      const n = wordLen;
      const { cellW, fontSize, startX, yc } = cellGeom(n);
      const font = `700 ${fontSize}px ${FONT}`;
      ctx.font = font;
      const now = performance.now();
      // The cursor is the leftmost empty, non-gold slot (= the next type target).
      // Only the local speller sees it blink; other clients render static cells.
      if (cursorEnabled) {
        for (let i = 0; i < n; i++) {
          if (!reveals.has(i) && (cells[i] ?? "_") === "_") { cursorIdx = i; break; }
        }
      }
      const glyphs: Glyph[] = [];
      for (let i = 0; i < n; i++) {
        const r = reveals.get(i);
        if (r) {
          // A still-fading reveal is drawn by the afterDraw overlay (cross/fade);
          // once settled it lives in the base layer as a solid gold letter.
          if (now - r.start < REVEAL_FADE) continue;
          const ch = r.letter.toUpperCase();
          glyphs.push({ ch, font, color: GOLD, x: startX + i * cellW + cellW / 2 - ctx.measureText(ch).width / 2, y: yc });
        } else {
          if (i === cursorIdx) continue; // the blinking-cursor overlay draws this slot
          const ch = cells[i] ?? "_";
          glyphs.push({ ch, font, color: "#f4f1e8", x: startX + i * cellW + cellW / 2 - ctx.measureText(ch).width / 2, y: yc });
        }
      }
      lines.push({ glyphs });
    }
    surf.setLines(lines);
    manageBlink();
  };

  // Run/stop the blink ticker so the cursor slot pulses while one exists.
  const manageBlink = () => {
    const want = cursorIdx >= 0 && !resultMode && !endMode;
    if (want && !blinkTimer) {
      cursorOn = true;
      blinkTimer = window.setInterval(() => { cursorOn = !cursorOn; surf.redraw(); }, BLINK_MS);
    } else if (!want && blinkTimer) {
      window.clearInterval(blinkTimer);
      blinkTimer = 0;
      cursorOn = true;
    }
  };

  // Draw the blinking "_" at the awaiting slot (skipped by the base layer).
  const drawCursorOverlay = (c: CanvasRenderingContext2D) => {
    if (cursorIdx < 0 || !cursorOn || resultMode || endMode) return;
    const n = wordLen;
    if (cursorIdx >= n) return;
    const { cellW, fontSize, startX, yc } = cellGeom(n);
    c.save();
    c.font = `700 ${fontSize}px ${FONT}`;
    c.textBaseline = "middle";
    c.textAlign = "left";
    c.fillStyle = "#f4f1e8";
    c.shadowColor = "rgba(0,0,0,0.4)";
    c.shadowBlur = 5;
    const w = c.measureText("_").width;
    c.fillText("_", startX + cursorIdx * cellW + cellW / 2 - w / 2, yc);
    c.restore();
  };

  // Golden-chalk reveal crossfade overlay: for each still-fading reveal, fade the
  // replaced char out and the gold letter in (settled reveals live in the base layer).
  const drawRevealOverlay = (c: CanvasRenderingContext2D) => {
    if (!reveals.size || resultMode || endMode) return;
    const n = wordLen;
    if (n < 1) return;
    const { cellW, fontSize, startX, yc } = cellGeom(n);
    const font = `700 ${fontSize}px ${FONT}`;
    const now = performance.now();
    c.save();
    c.textBaseline = "middle";
    c.textAlign = "left";
    c.font = font;
    c.shadowColor = "rgba(0,0,0,0.4)";
    c.shadowBlur = 5;
    for (const [i, r] of reveals) {
      if (i < 0 || i >= n) continue;
      const a = Math.min(1, (now - r.start) / REVEAL_FADE);
      if (a >= 1) continue; // settled — drawn by the base layer
      const cx = startX + i * cellW + cellW / 2;
      if (r.prev && r.prev !== "_") {
        c.globalAlpha = 1 - a; // old char fades out
        c.fillStyle = "#f4f1e8";
        c.fillText(r.prev, cx - c.measureText(r.prev).width / 2, yc);
      }
      const ch = r.letter.toUpperCase(); // gold fades in
      c.globalAlpha = a;
      c.fillStyle = GOLD;
      c.fillText(ch, cx - c.measureText(ch).width / 2, yc);
    }
    c.globalAlpha = 1;
    c.restore();
  };

  // Golden pulsing oval(s) the chalk is aiming at: all slots (mode 1) or the one
  // selected slot (mode 2). Opacity fades in/out in a loop.
  const drawAimOverlay = (c: CanvasRenderingContext2D) => {
    if (aimMode === 0 || resultMode || endMode) return;
    const n = wordLen;
    if (n < 1) return;
    const { cellW, fontSize, startX, yc } = cellGeom(n);
    const a = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(performance.now() / 260)); // fade loop
    c.save();
    c.strokeStyle = GOLD;
    c.lineWidth = 6;
    c.shadowColor = GOLD;
    c.shadowBlur = 18;
    c.globalAlpha = a;
    const drawOne = (i: number) => {
      const cx = startX + i * cellW + cellW / 2;
      c.beginPath();
      c.ellipse(cx, yc, cellW * 0.52, fontSize * 0.6, 0, 0, Math.PI * 2);
      c.stroke();
    };
    if (aimMode === 1) for (let i = 0; i < n; i++) drawOne(i);
    else if (aimIndex >= 0 && aimIndex < n) drawOne(aimIndex);
    c.restore();
  };
  const startAimPulse = () => { if (!aimTimer) aimTimer = window.setInterval(() => surf.redraw(), 33); };
  const stopAimPulse = () => { if (aimTimer) { window.clearInterval(aimTimer); aimTimer = 0; } };

  // Countdown bar just under the word row: a depleting fill that shifts green →
  // red as the turn's time runs out.
  const drawTimerOverlay = (c: CanvasRenderingContext2D) => {
    if (timerDur <= 0 || resultMode || endMode) return;
    const n = wordLen;
    if (n < 1) return;
    const frac = Math.max(0, Math.min(1, 1 - (performance.now() - timerStart) / timerDur));
    const { cellW, fontSize, startX, yc } = cellGeom(n);
    const bx = startX, bw = cellW * n;
    const by = yc + fontSize * 0.8 + 14, bh = 14; // dropped lower, clear of the word
    c.save();
    c.fillStyle = "rgba(0,0,0,0.34)"; // track
    pillPath(c, bx, by, bw, bh, bh / 2);
    c.fill();
    if (frac > 0) {
      c.fillStyle = `hsl(${Math.round(120 * frac)}, 85%, 55%)`; // green → red
      pillPath(c, bx, by, Math.max(bh, bw * frac), bh, bh / 2);
      c.fill();
    }
    c.restore();
  };
  const setTimer = (durationMs: number) => {
    timerStart = performance.now();
    timerDur = Math.max(1, durationMs);
    cancelAnimationFrame(timerRaf);
    let lastDraw = 0;
    const tick = (now: number) => {
      if (timerDur <= 0) return;
      if (now - lastDraw >= 80) { lastDraw = now; surf.redraw(); } // ~12fps is plenty
      if (performance.now() - timerStart < timerDur) timerRaf = requestAnimationFrame(tick);
      else surf.redraw(); // settle at empty
    };
    timerRaf = requestAnimationFrame(tick);
    surf.redraw();
  };
  const clearTimer = () => { timerDur = 0; cancelAnimationFrame(timerRaf); surf.redraw(); };

  surf.setAfterDraw((c) => { drawCursorOverlay(c); drawRevealOverlay(c); drawAimOverlay(c); drawTimerOverlay(c); drawSplatOverlay(c); });

  // Map a board UV (u across width, v with 0 at the bottom) to a letter-slot index.
  const slotAtUV = (u: number, v: number): number => {
    const n = wordLen;
    if (n < 1) return -1;
    const { cellW, fontSize, startX, yc } = cellGeom(n);
    const cx = u * W, cy = (1 - v) * H; // canvas is top-down; uv v=0 is the bottom
    if (cy < yc - fontSize * 0.78 || cy > yc + fontSize * 0.78) return -1; // off the row
    const i = Math.floor((cx - startX) / cellW);
    return i >= 0 && i < n ? i : -1;
  };

  // Reveal a letter at `index` in gold, crossfading from whatever was shown there.
  const revealLetter = (index: number, letter: string) => {
    if (index < 0 || !letter) return;
    const prev = cells[index] ?? "_"; // the char shown there (for the crossfade)
    reveals.set(index, { letter, start: performance.now(), prev });
    rebuild();
    cancelAnimationFrame(revealRaf);
    const anyFading = () => {
      const now = performance.now();
      for (const r of reveals.values()) if (now - r.start < REVEAL_FADE) return true;
      return false;
    };
    const tick = () => {
      surf.redraw();
      if (anyFading()) revealRaf = requestAnimationFrame(tick);
      else rebuild(); // settle: gold letters move into the base layer
    };
    revealRaf = requestAnimationFrame(tick);
  };
  const clearReveals = () => {
    reveals.clear();
    aimMode = 0; aimIndex = -1; stopAimPulse();
    cancelAnimationFrame(revealRaf);
  };
  // index < 0 turns aim off; index >= 0 aims (pulses) the single slot.
  const setAim = (index: number) => {
    if (index < 0) { aimMode = 0; aimIndex = -1; stopAimPulse(); }
    else { aimMode = 2; aimIndex = index; startAimPulse(); }
    surf.redraw();
  };
  // Aim ALL slots (pulsing) — the initial "pick any letter" state.
  const setAimAll = () => {
    aimMode = 1; aimIndex = -1; startAimPulse();
    surf.redraw();
  };
  const setCursorEnabled = (on: boolean) => {
    if (cursorEnabled === on) return;
    cursorEnabled = on;
    rebuild(); // recompute cursorIdx + (re)start/stop the blink
  };

  // Throw a tomato: splat covers all but the last 2 letters, growing in, holding,
  // then sliding down + fading over `durationMs`.
  const splatTomato = (durationMs: number) => {
    const cover = Math.max(0, cells.length - 2);
    if (cover <= 0) return;
    const duration = Math.max(400, durationMs);
    const revealMs = Math.min(320, duration * 0.3);
    const hideMs = Math.min(550, duration * 0.4);
    splat = { start: performance.now(), duration, revealMs, hideMs, cover, blobs: genSplatBlobs() };
    cancelAnimationFrame(splatRaf);
    // Cap splat redraws to ~30fps — each redraw re-uploads the whole board texture
    // to the GPU, so 60fps for the splat's full duration is wasteful.
    let lastDraw = 0;
    const tick = (now: number) => {
      if (!splat) return;
      if (now - lastDraw >= 33) { lastDraw = now; surf.redraw(); }
      if (performance.now() - splat.start < splat.duration) splatRaf = requestAnimationFrame(tick);
      else { splat = null; surf.redraw(); }
    };
    splatRaf = requestAnimationFrame(tick);
  };
  const clearSplat = () => { splat = null; cancelAnimationFrame(splatRaf); surf.redraw(); };

  const setGuess = (typed: string, length: number) => {
    resultMode = null; // typing always clears a prior result
    endMode = null;
    wordLen = Math.max(0, length);
    // `typed` is the positional per-slot display ("_" for empty / gold slots).
    const t = typed.toUpperCase();
    cells = [];
    for (let i = 0; i < wordLen; i++) cells.push(t[i] ?? "_");
    rebuild();
  };
  // Wrong: keep their `guess` (struck red) + the correct `answer` below in white.
  // Correct: the answer in green.
  const setResult = (guess: string, correct: boolean, answer: string) => {
    resultMode = { guess, correct, answer };
    rebuild();
  };
  const clear = (length: number) => { clearReveals(); setGuess("", length); };
  const setHeader = (text: string, accent: HeaderAccent | null = null) => {
    header = text;
    headerAccent = accent;
    rebuild();
  };
  const setEnd = (title: string, subtitle: string) => {
    endMode = { title, subtitle };
    rebuild();
  };

  setGuess("", 0);
  if (document.fonts) document.fonts.ready.then(() => rebuild()).catch(() => {});

  return {
    mesh, setGuess, setResult, clear, setHeader,
    writeIn: surf.writeIn, eraseOut: surf.eraseOut,
    splatTomato, clearSplat, setEnd,
    revealLetter, clearReveals, setAim, setAimAll, slotAtUV, setCursorEnabled,
    setTimer, clearTimer,
  };
}

// ---------------------------------------------------------------------------
// Secondary stats board (left of the main board): name (bold/underlined),
// live WPM, and match accuracy — all in the chalk font, same write-in/erase.
// ---------------------------------------------------------------------------
interface StatsBoard {
  mesh: THREE.Mesh;
  setStats(name: string, wpm: number, accuracy: number, mine: boolean): void;
  clear(): void;
  writeIn(onDone?: () => void): void;
  eraseOut(onDone?: () => void): void;
}

function makeStatsBoard(): StatsBoard {
  const W = 512, H = 680;
  const surf = makeSurface(W, H);
  const ctx = surf.ctx;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(STATS_W, STATS_H),
    new THREE.MeshBasicMaterial({ map: surf.tex, transparent: true })
  );
  mesh.name = "StatsBoardText";

  let state: { name: string; wpm: number; acc: number; mine: boolean } | null = null;
  // A "LABEL:  value" row, label muted + smaller, value bright + bigger.
  const statRow = (label: string, value: string, y: number): Line => ({
    glyphs: layoutCentered(ctx, [
      { text: `${label}:  `, color: "rgba(244,241,232,0.66)", font: `600 48px ${FONT}` },
      { text: value, color: "rgba(244,241,232,0.96)", font: `700 72px ${FONT}` },
    ], W / 2, y),
  });
  const rebuild = () => {
    if (!state) return surf.setLines([]);
    // Name on top; WPM + ACC stacked on two rows below, high enough that the
    // seated avatar doesn't cover them. ONLY the viewing client's own name gets
    // the yellow pill (black text, no underline); every other speller — including
    // bots — shows the basic white/bold/underlined style.
    const nameLine: Line = state.mine
      ? { glyphs: layoutCentered(ctx, [{ text: state.name, color: "#1b1b1b", font: `700 52px ${FONT}` }], W / 2, 80), pill: "#ffd23b" }
      : { glyphs: layoutCentered(ctx, [{ text: state.name, color: "#f4f1e8", font: `700 52px ${FONT}` }], W / 2, 80), underlineY: 98 };
    surf.setLines([
      nameLine,
      statRow("WPM", String(state.wpm), 224),
      statRow("ACC", `${state.acc}%`, 326),
    ]);
  };

  if (document.fonts) document.fonts.ready.then(() => rebuild()).catch(() => {});

  return {
    mesh,
    setStats: (name, wpm, accuracy, mine) => {
      // Skip the rebuild + full texture re-upload when nothing displayed changed
      // (setStats fires on every keystroke, but WPM/acc are integers).
      if (state && state.name === name && state.wpm === wpm && state.acc === accuracy && state.mine === mine) return;
      state = { name, wpm, acc: accuracy, mine };
      rebuild();
    },
    clear: () => {
      state = null;
      rebuild();
    },
    writeIn: surf.writeIn,
    eraseOut: surf.eraseOut,
  };
}
