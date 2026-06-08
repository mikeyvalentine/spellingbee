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
  setBoardResult(guess: string, correct: boolean, answer: string): void;
  clearBoard(length: number): void;
  setBoardHeader(text: string, accent?: { text: string; color: string } | null): void;
  /** Per-player stats on the secondary (left) board: name, WPM, accuracy %. */
  setStats(name: string, wpm: number, accuracy: number): void;
  clearStats(): void;
  /** Write both boards' current content in, one char at a time (turn start). */
  revealBoards(): void;
  /** Erase both boards, one char at a time (during the result pause). */
  hideBoards(onDone?: () => void): void;
  /** Tomato splats on the word cells (server-driven; shared by all viewers). */
  setSplats(cells: number[]): void;
  /** Local-only aiming highlight (target ± 1) while throwing a tomato. */
  setAim(index: number | null): void;
  /** Map a board-plane UV hit (from a raycast) to a word-cell index. */
  boardCellFromUV(u: number, v: number): number | null;
  /** Game-over screen on the main board: a title with an optional subtitle. */
  setEndScreen(title: string, subtitle: string): void;
}

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export async function loadClassroom(scene: THREE.Scene): Promise<Classroom> {
  const board = makeChalkboard();
  const stats = makeStatsBoard();
  let layout: ClassroomLayout;
  try {
    const gltf = await new GLTFLoader().loadAsync(GLB_URL);
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
    setSplats: board.setSplats,
    setAim: board.setAim,
    boardCellFromUV: board.cellFromUV,
    setEndScreen: board.setEnd,
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
  const mainCx = mountBoard(root, objs.get("frontwall"), board);
  // Stats plane on the secondary (tall, narrow) board off to the side.
  mountStatsBoard(root, stats, mainCx);

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

  return { root, lobbyCam, matchCam, seats, spellerPos: new THREE.Vector3(0, 0, 6), lights: { front: light } };
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
  setSplats(cells: number[]): void; // tomato splats (server-driven)
  setAim(index: number | null): void; // local aiming highlight
  cellFromUV(u: number, v: number): number | null; // raycast hit -> cell index
  setEnd(title: string, subtitle: string): void; // game-over screen
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

  let header = "";
  let headerAccent: HeaderAccent | null = null;
  let cells: string[] = [];
  let cellsColor = "#f4f1e8";
  let splatCells: number[] = []; // tomato splats (from the server — everyone sees)
  let aimIndex: number | null = null; // local-only aiming highlight (the thrower)
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
  const cellBox = (i: number, n: number) => {
    const { cellW, fontSize, startX, yc } = cellGeom(n);
    const h = fontSize * 1.2;
    return { x: startX + i * cellW, y: yc - h / 2, w: cellW, h };
  };

  const drawSplat = (c: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const r = Math.max(b.w, b.h) * 0.6;
    c.save();
    c.fillStyle = "rgba(190,28,28,0.96)";
    const blobs = [[0, 0, r], [-r * 0.5, -r * 0.3, r * 0.55], [r * 0.5, r * 0.35, r * 0.5], [r * 0.35, -r * 0.5, r * 0.4], [-r * 0.4, r * 0.45, r * 0.42]];
    for (const [dx, dy, rad] of blobs) { c.beginPath(); c.arc(cx + dx, cy + dy, rad, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = "rgba(140,18,18,0.97)";
    c.beginPath(); c.arc(cx, cy, r * 0.55, 0, Math.PI * 2); c.fill();
    c.restore();
  };

  // Drawn on top of the glyphs every frame: server splats (opaque) + the local
  // aim highlight (target ± 1, clamped).
  const drawOverlay = (c: CanvasRenderingContext2D) => {
    const n = cells.length;
    if (!n) return;
    for (const i of splatCells) {
      if (i >= 0 && i < n) drawSplat(c, cellBox(i, n));
    }
    if (aimIndex != null) {
      const lo = Math.max(0, aimIndex - 1), hi = Math.min(n - 1, aimIndex + 1);
      c.save();
      c.strokeStyle = "rgba(255,72,60,0.95)";
      c.lineWidth = 5;
      c.shadowColor = "rgba(255,40,30,0.75)";
      c.shadowBlur = 12;
      for (let i = lo; i <= hi; i++) {
        const b = cellBox(i, n);
        c.strokeRect(b.x + 3, b.y + 3, b.w - 6, b.h - 6);
      }
      c.restore();
    }
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
    if (endMode) {
      // Game-over screen: "GAME OVER" with the winner below (no header/cells).
      lines.push({ glyphs: layoutCentered(ctx, [{ text: endMode.title, color: CHALK, font: `700 96px ${FONT}` }], W / 2, 205), noReveal: true });
      if (endMode.subtitle) {
        lines.push({ glyphs: layoutCentered(ctx, [{ text: endMode.subtitle, color: CHALK, font: `600 54px ${FONT}` }], W / 2, 330), noReveal: true });
      }
      surf.setLines(lines);
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
    } else if (cells.length) {
      const n = cells.length;
      const { cellW, fontSize, startX, yc } = cellGeom(n);
      const font = `700 ${fontSize}px ${FONT}`;
      ctx.font = font;
      const glyphs: Glyph[] = cells.map((ch, i) => ({
        ch,
        font,
        color: cellsColor,
        x: startX + i * cellW + cellW / 2 - ctx.measureText(ch).width / 2,
        y: yc,
      }));
      lines.push({ glyphs });
    }
    surf.setLines(lines);
  };

  surf.setAfterDraw(drawOverlay);

  const setSplats = (arr: number[]) => { splatCells = arr.slice(); surf.redraw(); };
  const setAim = (idx: number | null) => { aimIndex = idx; surf.redraw(); };
  // Map a board UV hit (from a raycast) to a word-cell index, or null if the
  // click missed the word row.
  const cellFromUV = (u: number, v: number): number | null => {
    const n = cells.length;
    if (!n) return null;
    const x = u * W, y = (1 - v) * H; // CanvasTexture flipY: v=1 is the canvas top
    const { cellW, fontSize, startX, yc } = cellGeom(n);
    const h = fontSize * 1.3;
    if (y < yc - h / 2 || y > yc + h / 2) return null;
    const i = Math.floor((x - startX) / cellW);
    return i >= 0 && i < n ? i : null;
  };

  const setGuess = (typed: string, length: number) => {
    resultMode = null; // typing always clears a prior result
    endMode = null;
    const t = typed.toUpperCase().slice(0, length);
    cells = [];
    for (let i = 0; i < length; i++) cells.push(t[i] ?? "_");
    cellsColor = "#f4f1e8";
    rebuild();
  };
  // Wrong: keep their `guess` (struck red) + the correct `answer` below in white.
  // Correct: the answer in green.
  const setResult = (guess: string, correct: boolean, answer: string) => {
    resultMode = { guess, correct, answer };
    rebuild();
  };
  const clear = (length: number) => setGuess("", length);
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
    setSplats, setAim, cellFromUV, setEnd,
  };
}

// ---------------------------------------------------------------------------
// Secondary stats board (left of the main board): name (bold/underlined),
// live WPM, and match accuracy — all in the chalk font, same write-in/erase.
// ---------------------------------------------------------------------------
interface StatsBoard {
  mesh: THREE.Mesh;
  setStats(name: string, wpm: number, accuracy: number): void;
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

  let state: { name: string; wpm: number; acc: number } | null = null;
  // A "LABEL:  value" row, label muted + smaller, value bright + bigger.
  const statRow = (label: string, value: string, y: number): Line => ({
    glyphs: layoutCentered(ctx, [
      { text: `${label}:  `, color: "rgba(244,241,232,0.66)", font: `600 48px ${FONT}` },
      { text: value, color: "rgba(244,241,232,0.96)", font: `700 72px ${FONT}` },
    ], W / 2, y),
  });
  const rebuild = () => {
    if (!state) return surf.setLines([]);
    // Name on top (white, underlined); WPM + ACC stacked on two rows below, high
    // enough that the seated avatar doesn't cover them.
    const nameGlyphs = layoutCentered(ctx, [{ text: state.name, color: "rgba(244,241,232,0.95)", font: `700 52px ${FONT}` }], W / 2, 72);
    surf.setLines([
      { glyphs: nameGlyphs, underlineY: 110 },
      statRow("WPM", String(state.wpm), 224),
      statRow("ACC", `${state.acc}%`, 326),
    ]);
  };

  if (document.fonts) document.fonts.ready.then(() => rebuild()).catch(() => {});

  return {
    mesh,
    setStats: (name, wpm, accuracy) => {
      state = { name, wpm, acc: accuracy };
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
