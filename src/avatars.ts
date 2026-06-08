import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Participant } from "./types";

const TARGET_HEIGHT = 1.7; // normalize every model to ~human height
// These models' forward axis vs +Z. If they walk backwards, flip to Math.PI.
const MODEL_FACING_OFFSET = 0;
const CROSSFADE = 0.2; // seconds to blend between animation states
const MOVE_SPEED_THRESHOLD = 0.3; // m/s above which an avatar is "walking"
const RUN_SPEED_THRESHOLD = 6.0; // m/s above which walk becomes run (sprint)
// Start the landing animation this high above ground while descending, so the
// Jump_Idle (airtime) loop ends early and Jump_Land plays into the touchdown.
const LAND_ANTICIPATE_HEIGHT = 0.55;

// Speaking-loop speed driven by loudness (louder = faster). Wide range so it's
// dramatic where a mic level exists (browser).
const VOL_MIN_SPEED = 0.6; // near-silent → slow
const VOL_MAX_SPEED = 3.5; // loud → fast
const BASE_SPEAKING_SPEED = 3.2; // base before mic level is known (remote users)
// Loop the Yes clip only over its active range (fractions of duration), skipping
// the lead-in and the settle-to-neutral tail so continuous speech nods smoothly.
const YES_LOOP_START_FRAC = 0.08;
const YES_LOOP_END_FRAC = 0.8;

type AnimState =
  | "idle"
  | "walk"
  | "run"
  | "yes"
  | "jump"
  | "jump_idle"
  | "jump_land"
  | "wave"
  | "no"
  | "punch"
  | "hitreact"
  | "death"
  | "duck";
type JumpPhase = "ground" | "takeoff" | "air" | "land";

// Emote state -> clip base name. Number keys 1-6 trigger these (see input.ts).
const EMOTE_CLIPS: Record<string, string> = {
  wave: "Wave",
  no: "No",
  punch: "Punch",
  hitreact: "HitReact",
  death: "Death",
  duck: "Duck",
};
const EMOTE_STATES = Object.keys(EMOTE_CLIPS) as AnimState[];

interface ModelTemplate {
  scene: THREE.Object3D;
  clips: Partial<Record<AnimState, THREE.AnimationClip>>;
  scale: number;
  offset: THREE.Vector3;
}

interface Avatar {
  root: THREE.Object3D;
  name: string;
  modelIndex: number;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<AnimState, THREE.AnimationAction>>;
  state: AnimState;
  speaking: boolean;
  speakClip: AnimState; // "yes" or "no" — re-rolled each utterance for variety
  yesTimeScale: number;
  emote?: AnimState;
  emoteUntil: number;
  emoteHold: boolean; // hold the emote's peak pose until explicitly cleared
  emoteHoldTime: number; // clip time to freeze a held emote at (its peak pose)
  ring: THREE.Mesh;
  label: THREE.Sprite;
  isHost: boolean; // host gets a blue "(Host)" nametag
  speakerIcon: THREE.Sprite;
  bubble?: THREE.Sprite;
  bubbleTimer?: number;
  prevX: number;
  prevZ: number;
  prevY: number;
  moveSpeed: number;
  groundY: number;
  airborne: boolean;
  jumpPhase: JumpPhase;
  landUntil: number;
  landDuration: number;
  posed: boolean; // locked to idle (seated / speller) — skip the locomotion state machine
  target?: { x: number; y: number; z: number; ry: number }; // networked remote target
}

export class AvatarManager {
  private models: ModelTemplate[] = [];
  private avatars = new Map<string, Avatar>();
  private assigned = new Map<string, number>(); // userId -> model index
  private spawn = new THREE.Vector3(0, 0, 0);
  private ringRadius = 4;
  private groundSampler?: (x: number, z: number) => number | null;

  constructor(private scene: THREE.Scene) {}

  /** Provide a function returning the terrain height under (x,z), for jump/airborne detection. */
  setGroundSampler(fn: (x: number, z: number) => number | null): void {
    this.groundSampler = fn;
  }

  async loadModels(urls: string[]): Promise<void> {
    const loader = new GLTFLoader();
    this.models = await Promise.all(
      urls.map(async (url) => {
        const gltf = await loader.loadAsync(encodeURI(url));
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const scale = TARGET_HEIGHT / (size.y || 1);
        const offset = new THREE.Vector3(
          -center.x * scale,
          -box.min.y * scale,
          -center.z * scale
        );
        const byBase = (base: string) =>
          gltf.animations.find((c) => c.name.split("|").pop() === base);
        const clips: Partial<Record<AnimState, THREE.AnimationClip>> = {
          idle: byBase("Idle"),
          walk: byBase("Walk"),
          run: byBase("Run"),
          yes: byBase("Yes"),
          jump: byBase("Jump"),
          jump_idle: byBase("Jump_Idle"),
          jump_land: byBase("Jump_Land"),
        };
        for (const [state, base] of Object.entries(EMOTE_CLIPS)) {
          clips[state as AnimState] = byBase(base);
        }
        return { scene, clips, scale, offset };
      })
    );
  }

  get modelCount(): number {
    return this.models.length;
  }

  setLayout(spawn: THREE.Vector3, ringRadius: number): void {
    this.spawn.copy(spawn);
    this.ringRadius = ringRadius;
  }

  /** Picks a model not currently assigned to anyone; random once all are used. */
  pickUnusedModel(): number {
    if (this.models.length === 0) return 0;
    const used = new Set(this.assigned.values());
    const free: number[] = [];
    for (let i = 0; i < this.models.length; i++) if (!used.has(i)) free.push(i);
    const pool = free.length ? free : this.models.map((_, i) => i);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Removes a player's avatar and frees their model for reuse. */
  removePlayer(id: string): void {
    const a = this.avatars.get(id);
    if (a) {
      this.scene.remove(a.root);
      this.avatars.delete(id);
    }
    this.assigned.delete(id);
  }

  get(id: string): THREE.Object3D | undefined {
    return this.avatars.get(id)?.root;
  }

  /** Has an avatar been built for this id yet? */
  has(id: string): boolean {
    return this.avatars.has(id);
  }

  /**
   * Ensures an avatar exists for an arbitrary id (e.g. a server-side bot that
   * never sent a socket hello). Builds one at the spawn point if missing, using
   * its assigned model or a free one.
   */
  ensure(id: string, name: string): void {
    if (this.avatars.has(id)) return;
    const modelIndex = this.assigned.get(id) ?? this.pickUnusedModel();
    this.assigned.set(id, modelIndex);
    const avatar = this.build(name, modelIndex, this.spawn.clone(), 0);
    this.avatars.set(id, avatar);
  }

  /** Show/hide every avatar (used to switch between the room and a minigame). */
  setAllVisible(visible: boolean): void {
    for (const a of this.avatars.values()) a.root.visible = visible;
  }

  /** Reset any per-match root scaling back to normal. */
  resetScales(): void {
    for (const a of this.avatars.values()) a.root.scale.setScalar(1);
  }

  ids(): string[] {
    return [...this.avatars.keys()];
  }

  /** Assign (or reassign) a player's model. Rebuilds the avatar if it changed. */
  setModel(id: string, modelIndex: number): void {
    if (modelIndex < 0 || modelIndex >= this.models.length) return;
    this.assigned.set(id, modelIndex);
    const a = this.avatars.get(id);
    if (a && a.modelIndex !== modelIndex) {
      const pos = a.root.position.clone();
      const ry = a.root.rotation.y;
      const rebuilt = this.build(a.name, modelIndex, pos, ry);
      rebuilt.speaking = a.speaking;
      rebuilt.yesTimeScale = a.yesTimeScale;
      rebuilt.target = a.target;
      this.scene.remove(a.root);
      this.avatars.set(id, rebuilt);
    }
  }

  sync(list: Participant[]): void {
    const ids = new Set(list.map((p) => p.id));
    for (const [id, a] of this.avatars) {
      if (!ids.has(id)) {
        this.scene.remove(a.root);
        this.avatars.delete(id);
      }
    }
    list.forEach((p, i) => {
      if (!this.avatars.has(p.id)) this.addAvatar(p, i, list.length);
    });
  }

  private addAvatar(p: Participant, index: number, count: number): void {
    const angle = (index / Math.max(count, 1)) * Math.PI * 2;
    const pos = new THREE.Vector3(
      this.spawn.x + Math.cos(angle) * this.ringRadius,
      this.spawn.y,
      this.spawn.z + Math.sin(angle) * this.ringRadius
    );
    const modelIndex = this.assigned.get(p.id) ?? this.pickUnusedModel();
    this.assigned.set(p.id, modelIndex);
    const avatar = this.build(p.name, modelIndex, pos, -angle + Math.PI / 2);
    this.avatars.set(p.id, avatar);
  }

  private build(
    name: string,
    modelIndex: number,
    position: THREE.Vector3,
    rotationY: number
  ): Avatar {
    const template = this.models[modelIndex] ?? this.models[0];

    const root = new THREE.Group();
    const facing = new THREE.Group();
    facing.rotation.y = MODEL_FACING_OFFSET;
    const model = cloneSkinned(template.scene);
    model.scale.setScalar(template.scale);
    model.position.copy(template.offset);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    facing.add(model);
    root.add(facing);
    root.position.copy(position);
    root.rotation.y = rotationY;

    const mixer = new THREE.AnimationMixer(model);
    const actions: Partial<Record<AnimState, THREE.AnimationAction>> = {};
    const allStates: AnimState[] = [
      "idle",
      "walk",
      "run",
      "yes",
      "jump",
      "jump_idle",
      "jump_land",
      ...EMOTE_STATES,
    ];
    allStates.forEach((s) => {
      const clip = template.clips[s];
      if (clip) actions[s] = mixer.clipAction(clip);
    });
    // Jump takeoff/landing and all emotes are one-shots; everything else loops.
    const oneShots: AnimState[] = ["jump", "jump_land", ...EMOTE_STATES];
    for (const once of oneShots) {
      const act = actions[once];
      if (act) {
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
      }
    }
    // Start in idle.
    actions.idle?.play();
    const landDuration = template.clips.jump_land?.duration ?? 0.3;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.6, 32),
      new THREE.MeshBasicMaterial({
        color: 0x5b8cff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    root.add(ring);

    const label = makeLabel(name);
    label.position.set(0, 2.1, 0);
    root.add(label);

    const speakerIcon = makeIcon("🔊");
    speakerIcon.position.set(-label.scale.x / 2 - 0.13, 2.1, 0);
    speakerIcon.visible = false;
    root.add(speakerIcon);

    this.scene.add(root);

    return {
      root,
      name,
      modelIndex,
      mixer,
      actions,
      state: "idle",
      speaking: false,
      speakClip: "yes",
      yesTimeScale: BASE_SPEAKING_SPEED,
      emoteUntil: 0,
      emoteHold: false,
      emoteHoldTime: Infinity,
      ring,
      label,
      isHost: false,
      speakerIcon,
      prevX: position.x,
      prevZ: position.z,
      prevY: position.y,
      moveSpeed: 0,
      groundY: position.y,
      airborne: false,
      jumpPhase: "ground",
      landUntil: 0,
      landDuration,
      posed: false,
    };
  }

  /** Lock an avatar to a looping idle pose (seated player / current speller),
   *  skipping the movement/jump state machine so a lifted Y doesn't read as a jump. */
  setPosed(id: string, posed: boolean): void {
    const a = this.avatars.get(id);
    if (a) a.posed = posed;
  }

  setSpeaking(id: string, speaking: boolean): void {
    const a = this.avatars.get(id);
    if (!a) return;
    if (speaking && !a.speaking) {
      // New utterance: pick nod or head-shake, and a random base speed so it
      // varies even without a mic level (e.g. inside Discord). A real mic level
      // (browser) overrides this each frame via setVolume.
      a.speakClip = Math.random() < 0.5 ? "no" : "yes";
      a.yesTimeScale = 0.8 + Math.random() * 1.4; // 0.8x–2.2x
    }
    a.speaking = speaking;
  }

  /** Shows a transient transcription bubble above the avatar. */
  setBubble(id: string, text: string): void {
    const a = this.avatars.get(id);
    if (!a || !text) return;
    if (a.bubble) {
      a.root.remove(a.bubble);
      a.bubble = undefined;
    }
    const sprite = makeBubble(text);
    sprite.position.set(0, 2.6, 0);
    a.root.add(sprite);
    a.bubble = sprite;
    if (a.bubbleTimer) clearTimeout(a.bubbleTimer);
    a.bubbleTimer = window.setTimeout(() => {
      if (a.bubble) {
        a.root.remove(a.bubble);
        a.bubble = undefined;
      }
    }, 5000);
  }

  /** Plays a one-shot emote. Returns false (without playing) if the model lacks
   *  the clip, so callers can fall back to another emote. With `hold`, the final
   *  pose is held (clamped) until clearEmote() is called. */
  playEmote(id: string, emote: string, hold = false, stretch = 1): boolean {
    const a = this.avatars.get(id);
    if (!a || a.airborne) return false;
    const state = emote as AnimState;
    const action = a.actions[state];
    if (!action) return false; // this model doesn't have the clip (e.g. Zombie has no Duck)
    // Hard-stop an in-progress emote so two full-body gestures don't cross-blend.
    if (a.emote && a.emote !== state) a.actions[a.emote]?.stop();
    if (a.state === state) a.state = "idle"; // force transitionTo to restart this clip
    action.reset();
    // Stretch playback to last `stretch`x longer (e.g. the wrong-answer duck).
    action.setEffectiveTimeScale(stretch > 0 ? 1 / stretch : 1);
    a.emote = state;
    a.emoteHold = hold;
    const dur = action.getClip().duration;
    // Held emotes freeze at ~halfway (the crouch/extension peak), not the clip's
    // end (which returns to a neutral, near-standing pose).
    a.emoteHoldTime = hold ? dur * 0.5 : Infinity;
    a.emoteUntil = hold ? Infinity : performance.now() / 1000 + dur * stretch;
    return true;
  }

  /** Show/hide an avatar's floating nametag (the speller's is hidden mid-match). */
  setLabelVisible(id: string, visible: boolean): void {
    const a = this.avatars.get(id);
    if (a) a.label.visible = visible;
  }

  /** Marks an avatar as host: a blue nametag (vs the normal yellow name). */
  setHost(id: string, isHost: boolean): void {
    const a = this.avatars.get(id);
    if (!a || a.isHost === isHost) return;
    a.isHost = isHost;
    a.root.remove(a.label);
    a.label = makeLabel(a.name, isHost ? "#5b8cff" : "#ffdf3b");
    a.label.position.set(0, 2.1, 0);
    a.root.add(a.label);
  }

  /** Clears any active/held emote so the avatar returns to its normal state. */
  clearEmote(id: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    if (a.emote) {
      const act = a.actions[a.emote];
      if (act) act.paused = false; // un-freeze so it can fade out / replay later
    }
    a.emote = undefined;
    a.emoteHold = false;
    a.emoteHoldTime = Infinity;
  }

  /** Freezes a held emote at its peak pose (called after the mixer advances). */
  private freezeHeldEmote(a: Avatar): void {
    if (!a.emote || !a.emoteHold) return;
    const act = a.actions[a.emote];
    if (act && act.time >= a.emoteHoldTime) {
      act.time = a.emoteHoldTime;
      act.paused = true;
    }
  }

  setVolume(id: string, level: number): void {
    const a = this.avatars.get(id);
    if (!a) return;
    const l = Math.max(0, Math.min(1, level));
    a.yesTimeScale = VOL_MIN_SPEED + (VOL_MAX_SPEED - VOL_MIN_SPEED) * l;
  }

  setPosition(id: string, x: number, y: number, z: number, ry: number): void {
    const a = this.avatars.get(id);
    if (!a) return;
    if (!a.target) {
      a.root.position.set(x, y, z);
      a.root.rotation.y = ry;
    }
    a.target = { x, y, z, ry };
  }

  private transitionTo(a: Avatar, next: AnimState): void {
    if (a.state === next) return;
    const nextAction = a.actions[next];
    if (!nextAction) return; // clip missing — keep current
    const prevAction = a.actions[a.state];
    nextAction.reset();
    nextAction.setEffectiveWeight(1);
    nextAction.play();
    nextAction.fadeIn(CROSSFADE);
    prevAction?.fadeOut(CROSSFADE);
    a.state = next;
  }

  update(dt: number): void {
    const t = performance.now() / 1000;
    for (const a of this.avatars.values()) {
      // Invisible avatars (hidden seats, the match-camera seat, the speller's own
      // POV) don't need their skinned-mesh pose advanced — skip the per-frame
      // mixer.update entirely (the dominant per-avatar CPU cost). They're re-shown
      // and re-posed by seatPlayers() on the next state change.
      if (!a.root.visible) continue;
      // Posed avatars (seated players / the current speller) just loop idle —
      // they're placed each frame, so skip the locomotion/jump state machine.
      // A one-shot emote (e.g. the wrong-answer reaction) still plays through.
      if (a.posed) {
        if (a.emote && !a.emoteHold && t >= a.emoteUntil) a.emote = undefined;
        this.transitionTo(a, a.emote ?? "idle");
        a.mixer.update(dt);
        this.freezeHeldEmote(a);
        continue;
      }

      // Remote interpolation toward last networked target.
      if (a.target) {
        const k = 1 - Math.exp(-12 * dt);
        a.root.position.x += (a.target.x - a.root.position.x) * k;
        a.root.position.y += (a.target.y - a.root.position.y) * k;
        a.root.position.z += (a.target.z - a.root.position.z) * k;
        let d = a.target.ry - a.root.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        a.root.rotation.y += d * k;
      }

      // Movement from horizontal position delta (local input or remote interp).
      const dx = a.root.position.x - a.prevX;
      const dz = a.root.position.z - a.prevZ;
      const dy = a.root.position.y - a.prevY;
      const speed = Math.hypot(dx, dz) / Math.max(dt, 1e-3);
      a.prevX = a.root.position.x;
      a.prevZ = a.root.position.z;
      a.prevY = a.root.position.y;
      a.moveSpeed += (speed - a.moveSpeed) * Math.min(1, dt * 10); // smoothed
      const moving = a.moveSpeed > MOVE_SPEED_THRESHOLD;
      const running = a.moveSpeed > RUN_SPEED_THRESHOLD;
      // Track the terrain height beneath this avatar so "airborne" means above
      // the ground they're actually standing on (not a fixed spawn height).
      if (this.groundSampler) {
        const g = this.groundSampler(a.root.position.x, a.root.position.z);
        if (g != null) a.groundY = g;
      }
      const airborne = a.root.position.y - a.groundY > 0.06;
      const descending = dy < -0.0005;

      // Jump phases override locomotion: takeoff(Jump) -> air(Jump_Idle) ->
      // land(Jump_Land). Land starts while still descending so it reads early.
      let desired: AnimState;
      if (airborne) {
        if (!a.airborne) {
          a.jumpPhase = "takeoff"; // just left the ground
          desired = "jump";
        } else if (a.jumpPhase === "takeoff") {
          const j = a.actions.jump;
          if (j && j.isRunning()) {
            desired = "jump";
          } else {
            a.jumpPhase = "air";
            desired = "jump_idle";
          }
        } else if (a.jumpPhase === "land") {
          desired = "jump_land"; // anticipated land, still falling
        } else if (
          descending &&
          a.root.position.y - a.groundY < LAND_ANTICIPATE_HEIGHT
        ) {
          a.jumpPhase = "land";
          a.landUntil = t + a.landDuration;
          desired = "jump_land";
        } else {
          desired = "jump_idle";
        }
      } else {
        if (a.airborne && a.jumpPhase !== "land") {
          a.jumpPhase = "land"; // touched down without anticipation
          a.landUntil = t + a.landDuration;
        }
        if (a.jumpPhase === "land" && t < a.landUntil) {
          desired = "jump_land";
        } else {
          a.jumpPhase = "ground";
          if (a.emote && t >= a.emoteUntil) a.emote = undefined; // expired
          if (a.emote) {
            desired = a.emote; // emote plays fully even while moving
          } else if (moving) {
            desired = running ? "run" : "walk";
          } else {
            desired = a.speaking ? a.speakClip : "idle";
          }
        }
      }
      a.airborne = airborne;
      this.transitionTo(a, desired);

      if ((a.state === "yes" || a.state === "no") && a.actions[a.state]) {
        const act = a.actions[a.state]!;
        act.setEffectiveTimeScale(a.yesTimeScale);
        // Wrap within the active range instead of the full clip, so the
        // settle-to-neutral tail never plays during continuous speech.
        const dur = act.getClip().duration;
        const loopStart = dur * YES_LOOP_START_FRAC;
        const loopEnd = dur * YES_LOOP_END_FRAC;
        if (act.time >= loopEnd) act.time = loopStart + (act.time - loopEnd);
      }

      a.mixer.update(dt);
      this.freezeHeldEmote(a);

      // Speaking UI cues.
      a.speakerIcon.visible = a.speaking;
      const mat = a.ring.material as THREE.MeshBasicMaterial;
      if (a.speaking) {
        mat.opacity = 0.5 + Math.sin(t * 8) * 0.3;
        a.ring.scale.setScalar(1 + Math.sin(t * 8) * 0.08);
      } else {
        mat.opacity += (0 - mat.opacity) * Math.min(1, dt * 8);
      }
    }
  }
}

function makeLabel(name: string, color = "#ffdf3b"): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = 48;
  const pad = 20;
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  const textWidth = ctx.measureText(name).width;
  canvas.width = Math.ceil(textWidth + pad * 2);
  canvas.height = font + pad * 2;

  ctx.font = `600 ${font}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 7;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = color;
  ctx.fillText(name, pad, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  );
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(aspect * 0.3, 0.3, 1);
  return sprite;
}

function makeBubble(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = 40;
  const pad = 22;
  const maxChars = 26;
  ctx.font = `500 ${font}px system-ui, sans-serif`;

  // simple word wrap, max 3 lines
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 3);
  if (lines.length > 3) shown[2] = shown[2].slice(0, maxChars - 1) + "…";

  const lineH = font * 1.25;
  let textW = 0;
  for (const l of shown) textW = Math.max(textW, ctx.measureText(l).width);
  canvas.width = Math.ceil(textW + pad * 2);
  canvas.height = Math.ceil(shown.length * lineH + pad * 2);

  ctx.font = `500 ${font}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(10,12,18,0.78)";
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 18);
  ctx.fillStyle = "#ffffff";
  shown.forEach((l, i) => ctx.fillText(l, pad, pad + i * lineH));

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  );
  const k = 0.0035; // world units per pixel (keeps text size consistent)
  sprite.scale.set(canvas.width * k, canvas.height * k, 1);
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function makeIcon(glyph: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "48px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, 32, 34);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  );
  sprite.scale.set(0.28, 0.28, 1);
  return sprite;
}
