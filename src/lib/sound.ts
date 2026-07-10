/**
 * Programmatically generates and plays a premium notification chime
 * using the Web Audio API. This avoids having to load/fetch a static
 * audio file and works completely offline with zero latency.
 */
export function playNotificationChime() {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const audioCtx = new AudioContextClass();

    // Resume context if suspended (browser autoplay policy security)
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }

    const playTone = (freq: number, startTime: number, duration: number) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startTime);

      // Prevent click/pop with linear fade-in and exponential decay
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.12, startTime + 0.02); // Moderate pleasant volume
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.start(startTime);
      osc.stop(startTime + duration);
    };

    const now = audioCtx.currentTime;
    // Play a lovely double-tone chime (D5 followed by A5)
    playTone(587.33, now, 0.2); // D5
    playTone(880.00, now + 0.08, 0.3); // A5
  } catch (error) {
    console.error("Failed to play notification chime:", error);
  }
}
