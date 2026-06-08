import * as THREE from "three";
import type { Classroom } from "./classroom";

// Dev-only floating panel of sliders for tuning the classroom lights and the
// speller's transform live. Values can be copied out to bake back into code.

interface Slider {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
}

interface Group {
  title: string;
  sliders: Slider[];
  buttons?: { label: string; onClick: () => void }[];
  read(): Record<string, unknown>; // for "Copy values"
}

const v3 = (label: string, v: THREE.Vector3): Slider[] => [
  { label: `${label} x`, min: -10, max: 10, step: 0.05, get: () => v.x, set: (n) => (v.x = n) },
  { label: `${label} y`, min: -2, max: 8, step: 0.05, get: () => v.y, set: (n) => (v.y = n) },
  { label: `${label} z`, min: -12, max: 12, step: 0.05, get: () => v.z, set: (n) => (v.z = n) },
];

const round = (n: number) => Math.round(n * 100) / 100;

function pointLightGroup(title: string, l: THREE.PointLight): Group {
  return {
    title,
    sliders: [
      { label: "intensity", min: 0, max: 200, step: 1, get: () => l.intensity, set: (n) => (l.intensity = n) },
      { label: "distance", min: 0, max: 60, step: 0.5, get: () => l.distance, set: (n) => (l.distance = n) },
      { label: "decay", min: 0, max: 3, step: 0.05, get: () => l.decay, set: (n) => (l.decay = n) },
      ...v3("pos", l.position),
    ],
    read: () => ({
      intensity: round(l.intensity),
      distance: round(l.distance),
      decay: round(l.decay),
      pos: [round(l.position.x), round(l.position.y), round(l.position.z)],
    }),
  };
}

function rectLightGroup(title: string, l: THREE.RectAreaLight): Group {
  return {
    title,
    sliders: [
      { label: "intensity", min: 0, max: 40, step: 0.5, get: () => l.intensity, set: (n) => (l.intensity = n) },
      { label: "width", min: 0, max: 14, step: 0.1, get: () => l.width, set: (n) => (l.width = n) },
      { label: "height", min: 0, max: 14, step: 0.1, get: () => l.height, set: (n) => (l.height = n) },
      ...v3("pos", l.position),
    ],
    read: () => ({
      intensity: round(l.intensity),
      width: round(l.width),
      height: round(l.height),
      pos: [round(l.position.x), round(l.position.y), round(l.position.z)],
    }),
  };
}

export function setupDebug(classroom: Classroom): void {
  const { lights } = classroom;
  const groups: Group[] = [];

  groups.push({
    title: "Speller",
    sliders: [
      { label: "scale", min: 0.2, max: 3, step: 0.02, get: () => classroom.spellerScale, set: (n) => (classroom.spellerScale = n) },
      ...v3("pos", classroom.spellerPos),
    ],
    read: () => ({
      scale: round(classroom.spellerScale),
      pos: [round(classroom.spellerPos.x), round(classroom.spellerPos.y), round(classroom.spellerPos.z)],
    }),
  });
  groups.push({
    title: "Lobby seats (offset)",
    sliders: v3("pos", classroom.seatOffset),
    read: () => ({
      offset: [round(classroom.seatOffset.x), round(classroom.seatOffset.y), round(classroom.seatOffset.z)],
    }),
  });
  groups.push(pointLightGroup("Front point light", lights.front));
  if (lights.back) groups.push(pointLightGroup("Back point light", lights.back));
  if (lights.window instanceof THREE.RectAreaLight) groups.push(rectLightGroup("Window area light", lights.window));

  // Google TTS voice picker — click to preview (plays a sample) AND make it the
  // active game voice. Set GOOGLE_TTS_VOICE in .env to bake in your favorite.
  const VOICES: [string, string][] = [
    ["Neural2 F · female (default)", "en-US-Neural2-F"],
    ["Neural2 C · female", "en-US-Neural2-C"],
    ["Neural2 A · male", "en-US-Neural2-A"],
    ["Neural2 J · male", "en-US-Neural2-J"],
    ["Studio O · female (rich)", "en-US-Studio-O"],
    ["Studio Q · male (rich)", "en-US-Studio-Q"],
    ["Wavenet F · female", "en-US-Wavenet-F"],
    ["British · en-GB Neural2 A", "en-GB-Neural2-A"],
    ["Aussie · en-AU Neural2 A", "en-AU-Neural2-A"],
  ];
  let lastVoice = "en-US-Neural2-F";
  const previewVoice = (name: string) => {
    lastVoice = name;
    const a = new Audio(`/api/voice-preview?set=1&voice=${encodeURIComponent(name)}`);
    a.play().catch(() => {});
  };
  groups.push({
    title: "TTS voice (click to preview + use)",
    sliders: [],
    buttons: VOICES.map(([label, name]) => ({ label, onClick: () => previewVoice(name) })),
    read: () => ({ voice: lastVoice }),
  });

  // Right-side panel: per-chair (per-seat) position offsets in the lobby.
  const seatGroups: Group[] = classroom.seats.map((_, i) => ({
    title: `Chair ${i + 1}`,
    sliders: v3("pos", classroom.seatOffsets[i]),
    read: () => ({
      offset: [
        round(classroom.seatOffsets[i].x),
        round(classroom.seatOffsets[i].y),
        round(classroom.seatOffsets[i].z),
      ],
    }),
  }));

  const panels: HTMLElement[] = [];
  panels.push(buildPanel("debug-panel", "left", "⚙ Debug", groups));
  if (seatGroups.length) panels.push(buildPanel("debug-seats", "right", "🪑 Lobby chairs", seatGroups));

  // Debug panels are hidden by default; press H to toggle them.
  let shown = false;
  const apply = () => panels.forEach((p) => (p.style.display = shown ? "block" : "none"));
  apply();
  window.addEventListener("keydown", (e) => {
    if ((e.key === "h" || e.key === "H") && !e.repeat) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // not while typing
      shown = !shown;
      apply();
    }
  });
}

function buildPanel(id: string, side: "left" | "right", title: string, groups: Group[]): HTMLElement {
  const panel = document.createElement("div");
  panel.id = id;
  Object.assign(panel.style, {
    position: "fixed", top: "10px", [side]: "10px", zIndex: "40", width: "230px",
    maxHeight: "92vh", overflowY: "auto", background: "rgba(12,15,22,0.92)",
    border: "1px solid #2a3344", borderRadius: "10px", padding: "8px 10px",
    font: "11px system-ui, sans-serif", color: "#e9edf5",
    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
  } as any);

  const head = document.createElement("div");
  Object.assign(head.style, { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px", cursor: "pointer", userSelect: "none" });
  const titleEl = document.createElement("b");
  titleEl.style.color = "#ffd23b";
  titleEl.textContent = title;
  const toggle = document.createElement("span");
  toggle.style.color = "#9aa4b2";
  toggle.textContent = "▾";
  head.append(titleEl, toggle);
  panel.appendChild(head);

  const body = document.createElement("div");
  panel.appendChild(body);

  for (const g of groups) {
    const sec = document.createElement("div");
    sec.style.margin = "6px 0";
    const t = document.createElement("div");
    Object.assign(t.style, { color: "#9aa4b2", fontWeight: "600", margin: "6px 0 3px", borderTop: "1px solid #232a38", paddingTop: "6px" });
    t.textContent = g.title;
    sec.appendChild(t);
    for (const s of g.sliders) sec.appendChild(makeSlider(s));
    for (const b of g.buttons ?? []) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      Object.assign(btn.style, {
        display: "block", width: "100%", margin: "3px 0", padding: "5px 8px",
        border: "1px solid #2a3344", borderRadius: "7px", cursor: "pointer",
        background: "#161b25", color: "#e9edf5", font: "11px system-ui", textAlign: "left",
      } as any);
      btn.addEventListener("mouseenter", () => (btn.style.background = "#1d2230"));
      btn.addEventListener("mouseleave", () => (btn.style.background = "#161b25"));
      btn.addEventListener("click", b.onClick);
      sec.appendChild(btn);
    }
    body.appendChild(sec);
  }

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "📋 Copy values";
  Object.assign(copyBtn.style, {
    width: "100%", marginTop: "8px", padding: "7px", border: "0", borderRadius: "8px",
    background: "#ffd23b", color: "#0b0d12", fontWeight: "600", cursor: "pointer", font: "12px system-ui",
  } as any);
  copyBtn.addEventListener("click", () => {
    const out: Record<string, unknown> = {};
    for (const g of groups) out[g.title] = g.read();
    const json = JSON.stringify(out, null, 2);
    console.log("[debug values]\n" + json);
    navigator.clipboard?.writeText(json).catch(() => {});
    copyBtn.textContent = "✓ Copied";
    setTimeout(() => (copyBtn.textContent = "📋 Copy values"), 1400);
  });
  body.appendChild(copyBtn);

  let open = true;
  head.addEventListener("click", () => {
    open = !open;
    body.style.display = open ? "block" : "none";
    toggle.textContent = open ? "▾" : "▸";
  });

  document.body.appendChild(panel);
  return panel;
}

function makeSlider(s: Slider): HTMLElement {
  const row = document.createElement("div");
  Object.assign(row.style, { display: "grid", gridTemplateColumns: "58px 1fr 38px", gap: "5px", alignItems: "center", margin: "2px 0" });

  const label = document.createElement("span");
  label.textContent = s.label;
  label.style.color = "#cdd6e4";

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(s.min);
  input.max = String(s.max);
  input.step = String(s.step);
  input.value = String(s.get());
  input.style.width = "100%";
  (input.style as any).accentColor = "#ffd23b";

  const val = document.createElement("span");
  val.textContent = String(Math.round(s.get() * 100) / 100);
  Object.assign(val.style, { color: "#ffd23b", textAlign: "right", fontVariantNumeric: "tabular-nums" });

  input.addEventListener("input", () => {
    const n = parseFloat(input.value);
    s.set(n);
    val.textContent = String(Math.round(n * 100) / 100);
  });

  row.append(label, input, val);
  return row;
}
