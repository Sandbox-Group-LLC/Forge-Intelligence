// Generate an original, energetic music bed (CC0 — authored here, zero
// licensing risk). Driving / modern / premium-dark: 122 BPM four-on-the-floor
// kick, offbeat open hats, 16th closed hats, sidechained sub bass, plucked
// minor-key arp with stereo delay, pad swells. Written for the SYSOI reel but
// brand-agnostic. Output: public/audio/sysoi-music.wav (~64s, loopable).
import fs from "node:fs";

const SR = 44100;
const BPM = 122;
const BEAT = 60 / BPM;            // 0.4918s
const BAR = BEAT * 4;
const BARS = 32;                  // 32 bars ≈ 63s
const DUR = BAR * BARS;
const N = Math.floor(SR * DUR);
const L = new Float32Array(N);
const R = new Float32Array(N);

// A minor progression, two bars per chord: Am F C G
const CHORDS = [
  { root: 55.0, arp: [220.0, 261.63, 329.63, 440.0] },   // Am: A2 root, A3 C4 E4 A4
  { root: 43.65, arp: [174.61, 220.0, 261.63, 349.23] }, // F:  F1→F2 root, F3 A3 C4 F4
  { root: 65.41, arp: [261.63, 329.63, 392.0, 523.25] }, // C:  C2 root, C4 E4 G4 C5
  { root: 49.0, arp: [196.0, 246.94, 293.66, 392.0] },   // G:  G1 root, G3 B3 D4 G4
];
const chordAt = (t) => CHORDS[Math.floor(t / (BAR * 2)) % CHORDS.length];

const TAU = 2 * Math.PI;
let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

// Sidechain pump: dips hard right after every beat, recovers by the next.
const pump = (t) => {
  const ph = (t % BEAT) / BEAT;
  return 0.35 + 0.65 * Math.min(1, ph * 2.6) ** 1.6;
};

// Intro/outro arrangement: hats+arp from bar 2, bass from bar 4, full from 8.
const barOf = (t) => t / BAR;

let hpL = 0, hpR = 0, lpNoise = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const bar = barOf(t);
  const ch = chordAt(t);
  const sc = pump(t);

  // ── kick: 4-on-the-floor, pitch-dropping sine thump ──
  const kPh = t % BEAT;
  const kickOn = bar >= 0.0;
  const kick = kickOn
    ? Math.sin(TAU * (52 + 80 * Math.exp(-kPh * 38)) * kPh) * Math.exp(-kPh * 17) * 0.95
    : 0;

  // ── sub bass: 8th-note pulses on chord root, sidechained ──
  const eighth = t % (BEAT / 2);
  const bassEnv = Math.min(1, eighth * 90) * Math.exp(-eighth * 5.5);
  const bassOn = bar >= 4;
  const bass = bassOn
    ? (Math.sin(TAU * ch.root * 2 * t) + 0.3 * Math.sin(TAU * ch.root * 4 * t)) * bassEnv * sc * 0.34
    : 0;

  // ── closed hats: 16ths, short filtered-noise ticks, velocity pattern ──
  const six = t % (BEAT / 4);
  const sixIdx = Math.floor(t / (BEAT / 4)) % 4;
  const hatVel = [0.5, 0.22, 0.36, 0.22][sixIdx];
  const noise = rnd();
  hpL += (noise - hpL) * 0.55; // crude highpass via residual
  const hatsOn = bar >= 2;
  const hat = hatsOn ? (noise - hpL) * Math.exp(-six * 220) * hatVel : 0;

  // ── open hat on the offbeat ──
  const off = (t + BEAT / 2) % BEAT;
  const oHatOn = bar >= 8;
  const oHat = oHatOn ? (noise - hpL) * Math.exp(-off * 38) * 0.16 : 0;

  // ── pluck arp: 16th-note pattern up the chord, exponential decay ──
  const arpStep = Math.floor(t / (BEAT / 4));
  const arpNote = ch.arp[[0, 2, 1, 3, 0, 2, 3, 1][arpStep % 8]];
  const aPh = t % (BEAT / 4);
  const arpOn = bar >= 2;
  const arpRaw = (Math.sin(TAU * arpNote * t) + 0.4 * Math.sin(TAU * arpNote * 2 * t) + 0.15 * Math.sin(TAU * arpNote * 3 * t));
  const arp = arpOn ? arpRaw * Math.exp(-aPh * 26) * Math.min(1, aPh * 800) * 0.30 * sc : 0;

  // ── pad: slow chord swell, low in the mix ──
  const padEnv = (0.5 + 0.5 * Math.sin(TAU * (t / (BAR * 2)) - Math.PI / 2));
  const pad = (Math.sin(TAU * ch.arp[0] * 0.5 * t) + Math.sin(TAU * ch.arp[1] * 0.5 * t + 0.7) + Math.sin(TAU * ch.arp[2] * 0.5 * t + 1.3)) / 3 * padEnv * 0.12 * sc;

  // ── air: filtered noise bed, rises through the track ──
  lpNoise += (noise - lpNoise) * 0.03;
  const air = lpNoise * 0.035 * Math.min(1, bar / 16);

  const mono = kick + bass + pad + air;
  L[i] = mono + hat * 0.9 + oHat + arp * 1.0;
  R[i] = mono + hat * 1.1 + oHat * 0.8 + arp * 0.85;
}

// stereo delay on top end for width (feeds mostly the arp/hat residue)
function delay(buf, ms, fb, mix) {
  const d = Math.floor((ms / 1000) * SR);
  const wet = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const echo = i >= d ? wet[i - d] * fb : 0;
    wet[i] = buf[i] + echo;
    buf[i] = buf[i] * (1 - mix) + wet[i] * mix;
  }
}
delay(L, 3 / 8 * BEAT * 1000, 0.30, 0.18); // dotted-8th L
delay(R, BEAT / 2 * 1000, 0.28, 0.18);     // 8th R

// edge fades + soft clip + normalize to -11 dBFS (it's a bed under VO)
let peak = 0;
const fadeIn = SR * 0.8, fadeOut = SR * 2.5;
for (let i = 0; i < N; i++) {
  let g = 1;
  if (i < fadeIn) g = i / fadeIn;
  if (i > N - fadeOut) g = Math.min(g, (N - i) / fadeOut);
  L[i] = Math.tanh(L[i] * 1.1) * g;
  R[i] = Math.tanh(R[i] * 1.1) * g;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const target = Math.pow(10, -11 / 20);
const norm = peak > 0 ? target / peak : 1;

const bps = 2;
const dataLen = N * 2 * bps;
const buf = Buffer.alloc(44 + dataLen);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2 * bps, 28);
buf.writeUInt16LE(2 * bps, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
let off = 44;
for (let i = 0; i < N; i++) {
  buf.writeInt16LE((Math.max(-1, Math.min(1, L[i] * norm)) * 32767) | 0, off); off += 2;
  buf.writeInt16LE((Math.max(-1, Math.min(1, R[i] * norm)) * 32767) | 0, off); off += 2;
}
const out = new URL("../public/audio/sysoi-music.wav", import.meta.url).pathname;
fs.writeFileSync(out, buf);
console.log(`wrote ${out}  ${DUR.toFixed(1)}s  peak=${peak.toFixed(3)}  ${(buf.length / 1048576).toFixed(1)}MB`);
