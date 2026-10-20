/**
 * Renders the synthesised music bed to a WAV so it can be listened to, and
 * measures it so a silent or clipping bed fails loudly rather than quietly.
 *
 * The bed schedules itself against a live audio clock, which an
 * OfflineAudioContext does not have — it renders as fast as it can. So this
 * drives `schedule()` directly over a grid of steps, which is exactly what the
 * interval timer does at runtime, just without waiting for real seconds to go
 * past.
 *
 *   node tools/music.mjs [out.wav]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

const OUT = process.argv[2] || 'shots/music-preview.wav';
const SECONDS = 24;

const server = await createServer({ server: { port: 5205 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5205/', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async (seconds) => {
  const { default: Music } = await import('/src/audio/Music.js');
  const RATE = 44100;

  /** Render the bed with a scripted arc of energy and slow motion. */
  async function render(arc) {
    const ctx = new OfflineAudioContext(1, RATE * seconds, RATE);
    const music = new Music(ctx, ctx.destination);
    music.running = true;
    music.applyGain();

    const stepSeconds = 60 / 94 / 4;
    const total = Math.floor(seconds / stepSeconds);
    for (let i = 0; i < total; i++) {
      const when = i * stepSeconds;
      const { energy, slowmo } = arc(when / seconds);
      music.setEnergy(energy);
      // setSlowmo/applyGain schedule against a LIVE clock, whose currentTime is
      // pinned at 0 while an offline context renders — so every ramp would land
      // on top of every other one at the start. Same targets, scheduled here
      // against the render clock instead.
      music.slowmo = slowmo;
      music.out.gain.setTargetAtTime(music.gainTarget(), when, 0.08);
      music.filter.frequency.setTargetAtTime(music.filterTarget(), when, 0.08);
      music.schedule(i % 16, Math.floor(i / 16), when);
    }
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  const stats = (d) => {
    let sum = 0;
    let peak = 0;
    let silent = 0;
    let diff = 0;
    for (let i = 0; i < d.length; i++) {
      sum += d[i] * d[i];
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a < 1e-5) silent++;
      if (i > 0) diff += (d[i] - d[i - 1]) ** 2;
    }
    return {
      rms: +Math.sqrt(sum / d.length).toFixed(4),
      peak: +peak.toFixed(4),
      // RMS is a poor measure of "busier": the pad dominates it and barely
      // moves. The hats and the lead live at the top end, so the RMS of the
      // first difference — a crude high-pass — is what actually separates a
      // full kit from a bassline and a kick.
      bright: +Math.sqrt(diff / d.length).toFixed(4),
      silentFraction: +(silent / d.length).toFixed(3),
    };
  };

  // The arc a player actually hears: roll in, get up to speed, pop into slow
  // motion a third of the way through, land, carry on.
  const main = await render((t) => {
    const slowmo = t > 0.38 && t < 0.52 ? 1 : 0;
    return { energy: Math.min(1, 0.25 + t * 1.4), slowmo };
  });

  const quiet = await render(() => ({ energy: 0, slowmo: 0 }));
  const loud = await render(() => ({ energy: 1, slowmo: 0 }));
  const slow = await render(() => ({ energy: 1, slowmo: 1 }));

  return {
    main: Array.from(main),
    stats: { main: stats(main), quiet: stats(quiet), loud: stats(loud), slow: stats(slow) },
  };
}, SECONDS);

const s = result.stats;
console.log('              rms    peak   bright  silence');
for (const [k, v] of Object.entries(s)) {
  console.log(
    `  ${k.padEnd(10)} ${String(v.rms).padEnd(6)} ${String(v.peak).padEnd(6)} ` +
      `${String(v.bright).padEnd(7)} ${v.silentFraction}`,
  );
}

const problems = [];
if (s.main.rms < 0.005) problems.push('the bed is effectively silent');
if (s.main.peak >= 1.0) problems.push(`it clips (peak ${s.main.peak})`);
if (s.loud.bright <= s.quiet.bright * 1.5) problems.push('energy does not make it busier');
if (s.slow.rms >= s.loud.rms) problems.push('slow motion does not pull it back');
if (s.slow.bright >= s.loud.bright * 0.6) problems.push('slow motion does not darken it');
if (s.quiet.rms < 0.001) problems.push('a stationary rider gets nothing at all');

// 16-bit PCM mono.
const pcm = result.main;
const buf = Buffer.alloc(44 + pcm.length * 2);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + pcm.length * 2, 4);
buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(44100, 24);
buf.writeUInt32LE(44100 * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
}
fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
fs.writeFileSync(OUT, buf);
console.log(`\nwrote ${OUT} (${(buf.length / 1024).toFixed(0)}KB, ${SECONDS}s)`);

await browser.close();
await server.close();
console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join('\n  ')}` : '\nAll good.');
process.exit(problems.length ? 1 : 0);
