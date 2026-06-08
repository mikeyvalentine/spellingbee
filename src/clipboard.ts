import * as THREE from "three";

// A 3D clipboard "view-model" anchored in front of the camera. It sits mostly
// off the bottom of the screen (peek), rises a touch on hover, and slides up to
// fill the view on focus. The actual lobby controls are HTML positioned over the
// paper (see lobby.ts) — this module only owns the prop + its slide animation +
// pointer hit-testing + the focused paper's screen rect.
//
// Placeholder geometry for now; swap `buildPlaceholder()` for a loaded .glb later
// (keep the same local size/orientation so the poses below still line up).

export interface ClipboardView {
  group: THREE.Group;
  setVisible(v: boolean): void;
  update(dt: number): void; // anchor to camera + animate; call every frame
  hitTest(ndcX: number, ndcY: number): boolean; // pointer over the clipboard?
  setHover(h: boolean): void;
  focus(): void;
  blur(): void;
  toggle(): void;
  isFocused(): boolean;
  /** Screen rect (px) of the paper when focused + settled, else null. */
  paperRect(): { x: number; y: number; w: number; h: number } | null;
}

// Local (camera-space) poses. -Z is into the screen. Tuned by eye — expect to
// nudge these once it's on screen.
const POSE = {
  // Negative rotX tilts the TOP away from the camera (leaning back). Focus faces
  // the camera flat (rotX 0) so the HTML paper lines up cleanly + larger.
  peek: { pos: new THREE.Vector3(0, -1.62, -2.1), rotX: -0.32, scale: 1.0 },
  hover: { pos: new THREE.Vector3(0, -1.42, -2.05), rotX: -0.26, scale: 1.02 },
  focus: { pos: new THREE.Vector3(0, -0.05, -1.28), rotX: 0.0, scale: 1.52 },
};

// Paper size relative to the board (used for the focused screen-rect projection).
// A touch wider than before so the focused HTML controls have slack and headers
// don't briefly wrap as the panel finishes opening.
const PAPER_W = 1.1, PAPER_H = 1.36, PAPER_LOCAL_Y = 0.02;

function buildPlaceholder(): { group: THREE.Group; paper: THREE.Mesh } {
  const group = new THREE.Group();

  // Backing board (brown).
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.62, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.8, metalness: 0.05 })
  );
  group.add(board);

  // Paper (cream), slightly proud of the board.
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(PAPER_W, PAPER_H),
    new THREE.MeshStandardMaterial({ color: 0xf4efe2, roughness: 0.95 })
  );
  paper.position.set(0, PAPER_LOCAL_Y, 0.025);
  group.add(paper);

  // Clip at the top (metal bar + tab).
  const clipMat = new THREE.MeshStandardMaterial({ color: 0xbfc4cc, roughness: 0.35, metalness: 0.8 });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.06), clipMat);
  bar.position.set(0, 0.84, 0.05);
  group.add(bar);
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.05), clipMat);
  tab.position.set(0, 0.9, 0.07);
  group.add(tab);

  group.renderOrder = 999; // draw on top of the room
  group.traverse((o) => { (o as THREE.Mesh).renderOrder = 999; });
  return { group, paper };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function makeClipboard(camera: THREE.PerspectiveCamera): ClipboardView {
  const { group, paper } = buildPlaceholder();
  group.matrixAutoUpdate = false; // we drive its world matrix from the camera each frame

  let visible = true;
  let focused = false;
  let hover = false;
  let t = 0; // 0 = peek, 1 = focus
  let h = 0; // 0..1 hover blend (only matters near peek)

  const tmpQuat = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler();
  const tmpScale = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const cornerV = new THREE.Vector3();

  // Current interpolated local pose.
  const curPos = new THREE.Vector3();
  let curRotX = 0, curScale = 1;

  const computePose = () => {
    if (t > 0.001) {
      // peek/hover -> focus
      curPos.lerpVectors(POSE.peek.pos, POSE.focus.pos, t);
      curRotX = lerp(POSE.peek.rotX, POSE.focus.rotX, t);
      curScale = lerp(POSE.peek.scale, POSE.focus.scale, t);
    } else {
      // peek <-> hover (only when not focusing)
      curPos.lerpVectors(POSE.peek.pos, POSE.hover.pos, h);
      curRotX = lerp(POSE.peek.rotX, POSE.hover.rotX, h);
      curScale = lerp(POSE.peek.scale, POSE.hover.scale, h);
    }
  };

  const update = (dt: number) => {
    group.visible = visible;
    if (!visible) return;
    // Ease t and h toward targets.
    const k = 1 - Math.exp(-10 * Math.min(dt, 0.05));
    t += ((focused ? 1 : 0) - t) * k;
    h += ((hover && !focused ? 1 : 0) - h) * k;
    computePose();

    // World matrix = camera world * local offset (anchors it to the view).
    camera.updateMatrixWorld();
    local.compose(curPos, tmpQuat.setFromEuler(tmpEuler.set(curRotX, 0, 0)), tmpScale.set(curScale, curScale, curScale));
    group.matrix.multiplyMatrices(camera.matrixWorld, local);
    group.matrixWorldNeedsUpdate = true;
  };

  const hitTest = (ndcX: number, ndcY: number) => {
    if (!visible) return false;
    camera.updateMatrixWorld(); // fresh camera transform at tap time
    group.updateMatrixWorld(true);
    ndc.set(ndcX, ndcY);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(group, true).length > 0;
  };

  const paperRect = () => {
    // Mount a bit before fully settled so the panel rides up in sync with the
    // clipboard; the wider paper keeps the text from wrapping at this width.
    if (!visible || t < 0.93) return null;
    paper.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const hw = PAPER_W / 2, hh = PAPER_H / 2;
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
      cornerV.set(x, y, 0).applyMatrix4(paper.matrixWorld).project(camera);
      const sx = (cornerV.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-cornerV.y * 0.5 + 0.5) * window.innerHeight;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  };

  return {
    group,
    setVisible: (v) => { visible = v; if (!v) { focused = false; hover = false; } },
    update,
    hitTest,
    setHover: (v) => { hover = v; },
    focus: () => { focused = true; },
    blur: () => { focused = false; },
    toggle: () => { focused = !focused; },
    isFocused: () => focused,
    paperRect,
  };
}
