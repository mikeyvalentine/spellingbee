// Master audio bus. All sound routes through gain nodes so volume is adjustable:
//   master -> destination
//   music  -> master   (the looping background song)
//   sfx    -> master   (TTS narration + key clicks)
// Owns the AudioContext, the crossfading background-music loop, and SFX playback.
// Volumes persist to localStorage.

const LS_KEY = "sb-audio-v1";
const CROSSFADE = 5; // seconds of crossfade at each music loop boundary

export interface Volumes { master: number; music: number; sfx: number; }

export interface AudioBus {
  ctx: AudioContext;
  sfx: GainNode; // connect SFX source graphs here
  resume(): void; // unlock the context after a user gesture
  playSfx(buf: AudioBuffer, rate?: number): AudioBufferSourceNode;
  startMusic(url: string): Promise<void>; // load once + loop forever with crossfade
  setMusicEnabled(on: boolean): void; // gate music on/off (lobby-only) w/o touching the user's music volume
  volumes(): Volumes;
  setMaster(v: number): void;
  setMusic(v: number): void;
  setSfx(v: number): void;
}

export function makeAudioBus(): AudioBus {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  const music = ctx.createGain();
  const musicEnable = ctx.createGain(); // lobby-only gate, independent of user music volume
  const sfx = ctx.createGain();
  master.connect(ctx.destination);
  music.connect(musicEnable);
  musicEnable.connect(master);
  sfx.connect(master);
  musicEnable.gain.value = 1;

  const vols: Volumes = { master: 0.9, music: 0.4, sfx: 1 };
  try { Object.assign(vols, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); } catch { /* ignore */ }
  master.gain.value = vols.master;
  music.gain.value = vols.music;
  sfx.gain.value = vols.sfx;
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(vols)); } catch { /* ignore */ } };

  const resume = () => { if (ctx.state === "suspended") ctx.resume().catch(() => {}); };

  const playSfx = (buf: AudioBuffer, rate = 1) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    s.connect(sfx);
    s.start();
    return s;
  };

  // ---- looping background music with crossfade ----
  let musicBuf: AudioBuffer | null = null;
  let started = false;
  // Start one playthrough at AudioContext time `when`; returns when the NEXT loop
  // should begin (CROSSFADE before this one ends) so they overlap + crossfade.
  const playOne = (when: number) => {
    const src = ctx.createBufferSource();
    src.buffer = musicBuf!;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(music);
    const dur = musicBuf!.duration;
    const end = when + dur;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(1, when + CROSSFADE); // fade in
    g.gain.setValueAtTime(1, end - CROSSFADE);
    g.gain.linearRampToValueAtTime(0.0001, end); // fade out
    src.start(when);
    src.stop(end + 0.2);
    return end - CROSSFADE;
  };
  const scheduleLoop = (nextStart: number) => {
    const after = playOne(nextStart);
    const delayMs = Math.max(50, (after - ctx.currentTime - 0.5) * 1000);
    window.setTimeout(() => scheduleLoop(after), delayMs);
  };
  const startMusic = async (url: string) => {
    resume();
    if (started) return;
    started = true;
    try {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      musicBuf = await ctx.decodeAudioData(arr);
      scheduleLoop(ctx.currentTime + 0.15);
    } catch (e) {
      console.warn("[audio] music load failed:", e);
      started = false;
    }
  };

  // Smoothly gate the music on/off (e.g. lobby-only). Ramps a dedicated gain so
  // the user's chosen music volume is preserved when it comes back.
  const setMusicEnabled = (on: boolean) => {
    const t = ctx.currentTime;
    const g = musicEnable.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.linearRampToValueAtTime(on ? 1 : 0.0001, t + 0.8);
  };

  return {
    ctx,
    sfx,
    resume,
    playSfx,
    startMusic,
    setMusicEnabled,
    volumes: () => ({ ...vols }),
    setMaster: (v) => { vols.master = v; master.gain.value = v; save(); },
    setMusic: (v) => { vols.music = v; music.gain.value = v; save(); },
    setSfx: (v) => { vols.sfx = v; sfx.gain.value = v; save(); },
  };
}
