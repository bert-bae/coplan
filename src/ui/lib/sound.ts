/**
 * The alert chime for "Claude needs you".
 *
 * Synthesized with WebAudio rather than shipped as a file: the plugin's dist/
 * is committed to the repo, and a binary asset there would have to be
 * regenerated and reviewed on every build. Two short notes are also easier to
 * tune than an mp3 nobody can diff.
 *
 * Browsers refuse to start an AudioContext before the user has interacted
 * with the page, so the context is created lazily and resumed on the first
 * gesture. Until then `play()` is a silent no-op — which is correct: a tab
 * the user has never touched should not make noise.
 */

let context: AudioContext | null = null;
let armed = false;

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | null {
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Create the context on the first user gesture, when policy allows it. */
export function armAudio(): void {
  if (armed) return;
  armed = true;
  const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown'];
  const unlock = () => {
    try {
      const Ctor = audioCtor();
      if (!Ctor) return;
      context ??= new Ctor();
      void context.resume();
    } catch {
      /* no audio in this browser; the visual alerts still fire */
    }
    for (const event of events) window.removeEventListener(event, unlock);
  };
  for (const event of events) window.addEventListener(event, unlock, { once: false });
}

/**
 * A rising two-note chime. Short and quiet on purpose — this fires whenever a
 * session parks, which for a heavy user is often.
 */
export function playAlert(): void {
  const ctx = context;
  if (!ctx || ctx.state !== 'running') return;
  try {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.12;
    master.connect(ctx.destination);

    // E5 then B5: a fifth reads as a question being asked, not an error.
    for (const [index, frequency] of [659.25, 987.77].entries()) {
      const at = now + index * 0.13;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      // Ramped rather than switched, so it does not click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(1, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      osc.connect(gain).connect(master);
      osc.start(at);
      osc.stop(at + 0.3);
    }
  } catch {
    /* never let a chime break the UI */
  }
}
