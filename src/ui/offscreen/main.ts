/**
 * Offscreen document (reason: AUDIO_PLAYBACK). Service workers cannot play
 * audio, so the worker asks this page to play the alert sound. Chrome closes
 * the document on its own after a short silence.
 */
import { OFFSCREEN_CHANNEL, type OffscreenMessage } from "../../shared/messaging-types";

chrome.runtime.onMessage.addListener((msg: OffscreenMessage) => {
  if (msg?.channel === OFFSCREEN_CHANNEL && msg.kind === "play") void playChime();
  return false;
});

/** A short two-tone chime, synthesized (no audio file to ship). */
async function playChime() {
  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const t0 = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    const start = t0 + i * 0.18;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.4, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    osc.start(start);
    osc.stop(start + 0.17);
  });
  setTimeout(() => void ctx.close(), 600);
}
