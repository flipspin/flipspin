/** Retain waveform history so phrases travel outward as ring shapes.
 * Accept analyser bytes from the caller to reuse the shared audio graph. */

const SEGMENTS = 512; // matches the analyser's 512 bins (fftSize 1024)
const STRIP = SEGMENTS + 1; // the strip closes on itself
const UNIT = 50; // the circle's radius in scene units before a ring's scale
const FOV = (55 * Math.PI) / 180;
const NEAR = 1;
const FAR = 1_000_000;
const ZOOM_STEP = 50;
const ZOOM_MIN = 80;
const ZOOM_MAX = 2000;
const TILT_EASE = 0.3;
/** Resting view: looking down onto the rings from above and in front. */
const REST_PITCH = -1.05;
/** How far the pointer swings the view from rest, in radians, edge to edge:
 *  a full turn each way, so dragging across the screen orbits the whole disc. */
const PITCH_RANGE = 2 * Math.PI;
const YAW_RANGE = 2 * Math.PI;
/** Automatic gain: the loudest recent level decays this much per frame. */
const GAIN_DECAY = 0.995;
const GAIN_FLOOR = 0.12;

/** Flipspin's palette, dark-to-bright sound: coral → gold → teal → blue. */
const PALETTE: [number, number, number][] = [
  [0.95, 0.42, 0.29],
  [0.97, 0.75, 0.25],
  [0.26, 0.74, 0.66],
  [0.36, 0.55, 0.97],
];

/** The knobs. Every one is read each frame, so a change lands on the next one. */
export interface Params {
  /** The hole: the front ring's radius. The rim stays at `size`. */
  radius: number;
  /** How many rings of history recede from the hole to the rim. */
  rings: number;
  /** The rim: the outermost ring's radius. */
  size: number;
  /** How many of the 512 bins the loudness and colour read (512 = the whole spectrum). */
  band: number;
  /** The soft knee that lifts quiet passages; 0 is a straight line. */
  lift: number;
  /** Multiplier on the waveform's depth. */
  wave: number;
  /** Camera distance; the wheel moves it too. */
  distance: number;
  /** Auto motion: the steady yaw per frame. */
  drift: number;
  /** Auto motion: how far the slow sway tilts, in radians. */
  wander: number;
  /** How fast the palette turns on its own, on top of the sound's brightness; 0 holds it. */
  hueSpeed: number;
  /**
   * Bends the rings out of their plane: 0 is flat, negative pulls the outer
   * rings toward the viewer (a dish), positive pushes them away (a dome).
   */
  curve: number;
}

// Factory settings keep the initial ring appearance consistent across devices.
export const DEFAULT_PARAMS: Params = {
  radius: 90,
  rings: 48,
  size: 335,
  band: 256,
  lift: 1.5,
  wave: 1,
  distance: 470,
  drift: 0.0015,
  wander: 0.35,
  hueSpeed: 0.002,
  curve: 0,
};
/** The camera angle (pitch, yaw in radians) the rings open at when none was saved. */
export const DEFAULT_TILT = { x: -1.0205, y: -0.425 };
export const MAX_RINGS = 200;
/** How far the outermost ring moves at |curve| = 1, in scene units. */
const CURVE_DEPTH = 400;

const VERT = `
attribute vec2 aPos;
attribute float aZ;
uniform mat4 uMvp;
uniform vec3 uScale;
uniform float uZ;
void main() {
  gl_Position = uMvp * vec4(aPos * uScale.xy, aZ * uScale.z + uZ, 1.0);
}`;
const FRAG = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

export interface Readout {
  yaw: number;
  pitch: number;
  distance: number;
  /** The level that lit the front ring this frame, and the brightest in the history. */
  level: number;
  peak: number;
  /** Time-domain: RMS and the widest swing, both 0–1. */
  rms: number;
  swing: number;
  /** Spectrum: the loudest bin's frequency and the spectral centroid, in Hz. */
  peakHz: number;
  centroidHz: number;
  /** Mean byte level 0–1 in bass (<250 Hz), mids (250 Hz–4 kHz), highs (>4 kHz). */
  bass: number;
  mids: number;
  highs: number;
  fps: number;
}

export interface WaveRings {
  /** One frame from the analyser: 512 time-domain bytes, 512 frequency bytes. */
  /** `time` is float samples (−1…1, exact) or bytes (0…255, 8-bit). */
  frame(time: Float32Array | Uint8Array, freq: Uint8Array, sampleRate?: number): void;
  /** The canvas's CSS size and the pixel ratio to draw at. */
  resize(width: number, height: number, dpr: number): void;
  /** Pointer position in CSS pixels; the view eases toward it; unless locked. */
  tilt(x: number, y: number): void;
  /** Locked: the pointer no longer tilts the view (auto motion still runs). */
  setLocked(on: boolean): void;
  /** The tilt the pointer left, in radians, so it can be kept across openings. */
  getTilt(): { x: number; y: number };
  /** Restore a tilt: lands there at once, no easing in from the default. */
  setTilt(x: number, y: number): void;
  /** Positive moves the camera back. */
  zoom(direction: number): void;
  /** The rings turn and sway on their own; the pointer still tilts on top. */
  setMotion(on: boolean): void;
  /** Change any knob; takes effect on the next frame. */
  set(next: Partial<Params>): void;
  get(): Params;
  readout(): Readout;
  dispose(): void;
}

/** The palette at position p (0–1), as RGB 0–1. */
function paletteAt(p: number): [number, number, number] {
  const x = (((p % 1) + 1) % 1) * PALETTE.length;
  const i = Math.floor(x) % PALETTE.length;
  const j = (i + 1) % PALETTE.length;
  const f = x - Math.floor(x);
  const a = PALETTE[i];
  const b = PALETTE[j];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Column-major, the way WebGL wants them.
function perspective(aspect: number): Float32Array {
  const f = 1 / Math.tan(FOV / 2);
  const nf = 1 / (NEAR - FAR);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (FAR + NEAR) * nf, -1,
    0, 0, 2 * FAR * NEAR * nf, 0,
  ]);
}

// P · V · M: M pitches about x, then yaws about y; V pulls back along z.
function mvp(proj: Float32Array, pitch: number, yaw: number, cameraZ: number): Float32Array {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // R = Rx(pitch) · Ry(yaw), row-major
  const r = [
    [cy, 0, sy],
    [sp * sy, cp, -sp * cy],
    [-cp * sy, sp, cp * cy],
  ];
  const out = new Float32Array(16);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = proj[row] * r[0][col] + proj[4 + row] * r[1][col] + proj[8 + row] * r[2][col];
    }
  }
  for (let row = 0; row < 4; row++) out[12 + row] = proj[8 + row] * -cameraZ + proj[12 + row];
  return out;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader: ${log}`);
  }
  return sh;
}

/**
 * Returns null when the canvas cannot get a working WebGL context; no GPU,
 * a blocklisted driver, a context lost before the first frame. The caller
 * shows a sentence; it must never take the app down.
 */
export function createWaveRings(canvas: HTMLCanvasElement, initial: Partial<Params> = {}): WaveRings | null {
  try {
    return build(canvas, { ...DEFAULT_PARAMS, ...initial });
  } catch (err) {
    console.warn("visualizer: WebGL unavailable", err);
    return null;
  }
}

function build(canvas: HTMLCanvasElement, params: Params): WaveRings | null {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, premultipliedAlpha: false })
    || (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
  if (!gl || gl.isContextLost()) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const aPos = gl.getAttribLocation(program, "aPos");
  const aZ = gl.getAttribLocation(program, "aZ");
  const uMvp = gl.getUniformLocation(program, "uMvp");
  const uScale = gl.getUniformLocation(program, "uScale");
  const uZ = gl.getUniformLocation(program, "uZ");
  const uColor = gl.getUniformLocation(program, "uColor");

  // One circle shared by every ring.
  const circle = new Float32Array(STRIP * 2);
  for (let j = 0; j < STRIP; j++) {
    const a = (j / SEGMENTS) * Math.PI * 2;
    circle[j * 2] = Math.cos(a) * UNIT;
    circle[j * 2 + 1] = Math.sin(a) * UNIT;
  }
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, circle, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // The waveform history: MAX_RINGS slots in one buffer, a ring buffer over
  // time. Each frame writes only the newest slot; ring i points its depth
  // attribute at the slot written i frames ago.
  const histBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, histBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(MAX_RINGS * STRIP), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(aZ);
  const slot = new Float32Array(STRIP);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive: overlapping rings glow
  gl.clearColor(0, 0, 0, 1);

  // Per-slot history, the same ring buffer as the waveforms: the level that
  // lit it and the palette position it wore.
  const levels = new Float32Array(MAX_RINGS);
  const tints = new Float32Array(MAX_RINGS);
  let head = 0; // the slot written last
  let gain = GAIN_FLOOR;
  let tintDrift = 0;

  let width = 1;
  let height = 1;
  let proj = perspective(1);
  let cameraZ = params.distance;
  let pitch = REST_PITCH;
  let yaw = 0;
  let targetPitch = REST_PITCH;
  let targetYaw = 0;
  let motion = false;
  let locked = false;
  let spin = 0;
  let swayT = 0;
  let disposed = false;
  const sig = { rms: 0, swing: 0, peakHz: 0, centroidHz: 0, bass: 0, mids: 0, highs: 0, fps: 0 };
  let frames = 0;
  let fpsAt = 0;

  const slotOf = (age: number) => (head - age + MAX_RINGS) % MAX_RINGS;

  return {
    resize(w, h, dpr) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      proj = perspective(width / height);
    },
    tilt(x, y) {
      if (locked) return;
      // The pointer orbits the view around its resting angle, a full turn edge to edge.
      targetYaw = (x / width - 0.5) * YAW_RANGE;
      targetPitch = REST_PITCH + (y / height - 0.5) * PITCH_RANGE;
    },
    zoom(direction) {
      cameraZ = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cameraZ + Math.sign(direction) * ZOOM_STEP));
      params.distance = cameraZ;
    },
    setMotion(on) {
      motion = on;
    },
    setLocked(on) {
      locked = on;
    },
    getTilt() {
      return { x: targetPitch, y: targetYaw };
    },
    setTilt(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      // A tilt saved by the old rings (a full turn around π) is out of range here.
      if (Math.abs(x - REST_PITCH) > PITCH_RANGE || Math.abs(y) > YAW_RANGE) return;
      targetPitch = pitch = x;
      targetYaw = yaw = y;
    },
    set(next) {
      Object.assign(params, next);
      params.rings = Math.max(1, Math.min(MAX_RINGS, Math.round(params.rings)));
      if (next.distance !== undefined) cameraZ = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next.distance));
    },
    get() {
      return { ...params, distance: cameraZ };
    },
    readout() {
      const deg = (r: number) => {
        const d = ((r * 180) / Math.PI + 180) % 360;
        return (d < 0 ? d + 360 : d) - 180;
      };
      let peak = 0;
      for (let i = 0; i < params.rings; i++) peak = Math.max(peak, levels[slotOf(i)]);
      return { yaw: deg(yaw), pitch: deg(pitch), distance: cameraZ, level: levels[head], peak, ...sig };
    },
    frame(time, freq, sampleRate = 44100) {
      if (disposed || time.length < SEGMENTS || freq.length < SEGMENTS) return;
      const ringCount = params.rings;
      const band = Math.max(1, Math.min(SEGMENTS, Math.round(params.band)));
      const hzPerBin = sampleRate / 2 / SEGMENTS;

      // Loudness: the band's energy (root mean square of the bins), against
      // an automatic gain that follows the loudest recent moment, so a quiet
      // record and a loud one both fill the range.
      let energy = 0;
      let bandMass = 0;
      let bandMoment = 0;
      for (let i = 0; i < band; i++) {
        const m = freq[i] / 255;
        energy += m * m;
        bandMass += m;
        bandMoment += m * i;
      }
      const e = Math.sqrt(energy / band);
      gain = Math.max(GAIN_FLOOR, gain * GAIN_DECAY, e);
      const u = Math.min(1, e / gain);
      const level = params.lift > 0 ? (1 - Math.exp(-params.lift * u)) / (1 - Math.exp(-params.lift)) : u;

      // Colour: how bright the sound is (the band's centroid, on a log scale
      // from 60 Hz to the band's top), turned slowly by `hueSpeed`.
      const centroidHz = bandMass > 0 ? (bandMoment / bandMass) * hzPerBin : 60;
      const topHz = Math.max(120, band * hzPerBin);
      const bright = Math.log(Math.max(60, centroidHz) / 60) / Math.log(topHz / 60);
      tintDrift += params.hueSpeed;

      head = (head + 1) % MAX_RINGS;
      levels[head] = level;
      tints[head] = Math.min(1, Math.max(0, bright)) * 0.75 + tintDrift;

      const float = time instanceof Float32Array
      for (let j = 0; j < SEGMENTS; j++) slot[j] = float ? Math.max(-1, Math.min(1, time[j])) : (time[j] - 128) / 128;
      slot[SEGMENTS] = slot[0];
      gl.bindBuffer(gl.ARRAY_BUFFER, histBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, head * STRIP * 4, slot);

      // The readout's figures.
      let sq = 0;
      let swing = 0;
      for (let j = 0; j < SEGMENTS; j++) {
        const d = slot[j];
        sq += d * d;
        if (Math.abs(d) > swing) swing = Math.abs(d);
      }
      sig.rms = Math.sqrt(sq / SEGMENTS);
      sig.swing = swing;
      let top = 0;
      let mass = 0;
      let moment = 0;
      let bass = 0;
      let mids = 0;
      let highs = 0;
      const bassEnd = Math.min(SEGMENTS, Math.ceil(250 / hzPerBin));
      const midEnd = Math.min(SEGMENTS, Math.ceil(4000 / hzPerBin));
      for (let i = 0; i < SEGMENTS; i++) {
        const m = freq[i];
        if (m > freq[top]) top = i;
        mass += m;
        moment += m * i;
        if (i < bassEnd) bass += m;
        else if (i < midEnd) mids += m;
        else highs += m;
      }
      sig.peakHz = mass > 0 ? top * hzPerBin : 0;
      sig.centroidHz = mass > 0 ? (moment / mass) * hzPerBin : 0;
      sig.bass = bass / Math.max(1, bassEnd) / 255;
      sig.mids = mids / Math.max(1, midEnd - bassEnd) / 255;
      sig.highs = highs / Math.max(1, SEGMENTS - midEnd) / 255;
      frames += 1;
      const now = performance.now();
      if (now - fpsAt >= 1000) {
        sig.fps = fpsAt ? Math.round((frames * 1000) / (now - fpsAt)) : 0;
        frames = 0;
        fpsAt = now;
      }

      // The view: eased toward the pointer, plus a steady spin and a slow
      // two-tone sway when motion is on.
      let wantPitch = targetPitch;
      let wantYaw = targetYaw;
      if (motion) {
        spin += params.drift;
        swayT += 0.006;
        wantPitch += Math.sin(swayT * 0.7) * params.wander * 0.5;
        wantYaw += spin + Math.sin(swayT * 0.43 + 1.3) * params.wander;
      }
      pitch += (wantPitch - pitch) * TILT_EASE;
      yaw += (wantYaw - yaw) * TILT_EASE;
      gl.uniformMatrix4fv(uMvp, false, mvp(proj, pitch, yaw, cameraZ));

      gl.clear(gl.COLOR_BUFFER_BIT);
      // Rings spaced from the hole to the rim on an ease-out curve: close
      // together near the centre where the newest moments are, opening up
      // toward the rim. The hole can never reach the rim.
      const inner = Math.min(params.radius, params.size * 0.9);
      const depthScale = 18 * params.wave;
      for (let i = 0; i < ringCount; i++) {
        const age = ringCount > 1 ? i / (ringCount - 1) : 0;
        const radius = inner + (params.size - inner) * (1 - (1 - age) * (1 - age));
        const s = slotOf(i);
        const lit = levels[s];
        // Older rings fade, so the present reads first.
        const fade = 1 - age * 0.55;
        const [r, g, b] = paletteAt(tints[s]);
        const light = 0.25 + lit * 0.75;
        gl.uniform4f(uColor, r * light, g * light, b * light, Math.min(1, (0.08 + lit) * fade));
        const scale = radius / UNIT;
        gl.uniform3f(uScale, scale, scale, depthScale * (0.4 + lit));
        gl.uniform1f(uZ, -params.curve * CURVE_DEPTH * age * age);
        gl.vertexAttribPointer(aZ, 1, gl.FLOAT, false, 0, s * STRIP * 4);
        gl.drawArrays(gl.LINE_STRIP, 0, STRIP);
      }
    },
    dispose() {
      disposed = true;
      gl.deleteBuffer(posBuf);
      gl.deleteBuffer(histBuf);
      gl.deleteProgram(program);
      // Not `loseContext()`: React's dev StrictMode mounts twice, and a canvas
      // whose context was lost hands the second mount that same dead context.
    },
  };
}
