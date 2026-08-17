/* Tundra Defense — chiptune music engine (Game Boy style, pure WebAudio)
   Two pulse channels + triangle bass + noise drums, 16-step sequencer.
   Tempo scales by +1% per wave via setTempoScale().                       */
(function () {
  const G = (globalThis.G = globalThis.G || {});
  const n = null;

  /* K = kick, S = snare, H = hat. Notes are MIDI numbers. */
  const TRACKS = {
    menu: {
      bpm: 84,
      mel: [
        [72, n, n, n, 76, n, n, n, 79, n, n, n, 76, n, n, n],
        [74, n, n, n, 77, n, n, n, 81, n, n, n, 77, n, n, n],
        [72, n, n, n, 76, n, n, n, 79, n, n, n, 84, n, n, n],
        [83, n, n, n, 79, n, n, n, 76, n, n, n, 74, n, n, n],
      ],
      harm: null,
      bass: [
        [48, n, n, n, n, n, n, n, 55, n, n, n, n, n, n, n],
        [50, n, n, n, n, n, n, n, 57, n, n, n, n, n, n, n],
        [45, n, n, n, n, n, n, n, 52, n, n, n, n, n, n, n],
        [43, n, n, n, n, n, n, n, 50, n, n, n, n, n, n, n],
      ],
      drums: null,
    },
    frost: { // levels 1-3: sunny march in C
      bpm: 112,
      mel: [
        [72, n, 76, n, 79, n, 76, n, 72, n, 76, n, 81, n, 79, n],
        [77, n, 76, n, 74, n, 76, n, 72, n, 69, n, 67, n, 71, n],
        [72, n, 76, n, 79, n, 76, n, 84, n, 81, n, 79, n, 76, n],
        [77, n, 79, n, 81, n, 79, n, 76, n, 74, n, 72, n, n, n],
      ],
      harm: [
        [n, 60, n, 64, n, 67, n, 64, n, 60, n, 64, n, 67, n, 64],
        [n, 65, n, 69, n, 72, n, 69, n, 65, n, 69, n, 72, n, 69],
        [n, 60, n, 64, n, 67, n, 64, n, 60, n, 64, n, 67, n, 64],
        [n, 62, n, 67, n, 71, n, 67, n, 62, n, 67, n, 71, n, 67],
      ],
      bass: [
        [48, n, n, n, 55, n, n, n, 48, n, n, n, 55, n, 48, n],
        [53, n, n, n, 60, n, n, n, 53, n, n, n, 60, n, 53, n],
        [48, n, n, n, 55, n, n, n, 48, n, n, n, 55, n, 48, n],
        [43, n, n, n, 50, n, n, n, 43, n, n, n, 50, n, 43, n],
      ],
      drums: [
        ['K', n, 'H', n, 'S', n, 'H', n, 'K', n, 'H', n, 'S', n, 'H', 'H'],
        ['K', n, 'H', n, 'S', n, 'H', n, 'K', n, 'H', n, 'S', n, 'H', 'H'],
        ['K', n, 'H', n, 'S', n, 'H', n, 'K', n, 'H', n, 'S', n, 'H', 'H'],
        ['K', n, 'H', n, 'S', n, 'H', n, 'K', 'K', 'H', n, 'S', n, 'S', 'H'],
      ],
    },
    deep: { // levels 4-7: mysterious A minor
      bpm: 106,
      mel: [
        [69, n, 72, n, 76, n, 72, n, 69, n, 72, n, 77, n, 76, n],
        [69, n, 72, n, 76, n, 72, n, 81, n, 79, n, 76, n, 72, n],
        [68, n, 71, n, 76, n, 71, n, 68, n, 71, n, 74, n, 71, n],
        [69, n, 72, n, 76, n, 79, n, 81, n, n, n, 76, n, n, n],
      ],
      harm: [
        [57, n, n, n, n, n, 57, n, n, n, 57, n, n, n, n, n],
        [57, n, n, n, n, n, 57, n, n, n, 57, n, n, n, n, n],
        [52, n, n, n, n, n, 52, n, n, n, 52, n, n, n, n, n],
        [57, n, n, n, n, n, 53, n, n, n, 52, n, n, n, n, n],
      ],
      bass: [
        [45, n, n, 45, n, n, 45, n, 45, n, n, 45, n, n, 48, n],
        [45, n, n, 45, n, n, 45, n, 45, n, n, 45, n, n, 43, n],
        [40, n, n, 40, n, n, 40, n, 40, n, n, 40, n, n, 40, n],
        [45, n, n, 45, n, n, 45, n, 41, n, n, 41, n, n, 40, n],
      ],
      drums: [
        ['K', n, n, 'H', n, n, 'S', n, n, 'H', n, n, 'K', n, 'H', n],
        ['K', n, n, 'H', n, n, 'S', n, n, 'H', n, n, 'K', n, 'H', n],
        ['K', n, n, 'H', n, n, 'S', n, n, 'H', n, n, 'K', n, 'H', n],
        ['K', n, n, 'H', n, n, 'S', n, 'K', n, 'H', n, 'S', n, 'S', n],
      ],
    },
    storm: { // levels 8-10: driving E minor
      bpm: 122,
      mel: [
        [76, n, n, 74, 76, n, 79, n, 76, n, 74, n, 71, n, 74, n],
        [76, n, n, 74, 76, n, 79, n, 83, n, 81, n, 79, n, 76, n],
        [74, n, n, 72, 74, n, 77, n, 74, n, 72, n, 69, n, 72, n],
        [76, n, 74, n, 71, n, 69, n, 68, n, 71, n, 64, n, n, n],
      ],
      harm: [
        [n, n, 64, n, n, n, 64, n, n, n, 64, n, n, n, 64, n],
        [n, n, 64, n, n, n, 64, n, n, n, 67, n, n, n, 67, n],
        [n, n, 62, n, n, n, 62, n, n, n, 62, n, n, n, 62, n],
        [n, n, 64, n, n, n, 64, n, n, n, 64, n, n, n, n, n],
      ],
      bass: [
        [40, 40, n, 40, 40, n, 40, 40, n, 40, 40, n, 40, 40, 52, n],
        [40, 40, n, 40, 40, n, 40, 40, n, 40, 40, n, 40, 40, 52, n],
        [38, 38, n, 38, 38, n, 38, 38, n, 38, 38, n, 38, 38, 50, n],
        [36, 36, n, 36, 36, n, 36, 36, n, 36, 36, n, 40, 40, 40, n],
      ],
      drums: [
        ['K', n, 'H', 'H', 'S', n, 'H', n, 'K', 'K', 'H', n, 'S', n, 'H', 'H'],
        ['K', n, 'H', 'H', 'S', n, 'H', n, 'K', 'K', 'H', n, 'S', n, 'H', 'H'],
        ['K', n, 'H', 'H', 'S', n, 'H', n, 'K', 'K', 'H', n, 'S', n, 'H', 'H'],
        ['K', n, 'H', 'H', 'S', n, 'H', n, 'K', 'K', 'H', n, 'S', 'S', 'H', 'H'],
      ],
    },
  };

  const freq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const M = {
    actx: null, master: null, noiseBuf: null,
    track: null, trackName: null,
    tempoScale: 1, muted: false, vol: 1, paused: false,
    step: 0, bar: 0, nextTime: 0, timer: null,
  };
  const PEAK = 0.15;                       // full-volume gain for the whole bed
  const gainNow = () => (M.muted || M.paused ? 0 : PEAK * M.vol);
  function applyGain() { if (M.master) M.master.gain.value = gainNow(); }

  function ensureCtx() {
    if (M.actx) return true;
    try {
      M.actx = new (window.AudioContext || window.webkitAudioContext)();
      M.master = M.actx.createGain();
      M.master.gain.value = gainNow();
      M.master.connect(M.actx.destination);
      const len = M.actx.sampleRate * 0.3 | 0;
      M.noiseBuf = M.actx.createBuffer(1, len, M.actx.sampleRate);
      const d = M.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return true;
    } catch (e) { return false; }
  }

  function voice(type, midi, t0, len, vol) {
    const o = M.actx.createOscillator();
    const g = M.actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq(midi), t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.004);       // soft attack — no click
    g.gain.exponentialRampToValueAtTime(0.0015, t0 + len);
    g.gain.linearRampToValueAtTime(0, t0 + len + 0.015);   // land at true zero before stop
    o.connect(g).connect(M.master);
    o.start(t0); o.stop(t0 + len + 0.03);
  }

  function drum(kind, t0) {
    if (kind === 'K') {
      const o = M.actx.createOscillator();
      const g = M.actx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t0);
      o.frequency.exponentialRampToValueAtTime(44, t0 + 0.1);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.42, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0015, t0 + 0.12);
      g.gain.linearRampToValueAtTime(0, t0 + 0.135);
      o.connect(g).connect(M.master);
      o.start(t0); o.stop(t0 + 0.15);
    } else {
      const src = M.actx.createBufferSource();
      src.buffer = M.noiseBuf;
      const f = M.actx.createBiquadFilter();
      const g = M.actx.createGain();
      if (kind === 'S') {
        f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.28, t0 + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0015, t0 + 0.09);
        g.gain.linearRampToValueAtTime(0, t0 + 0.098);
      } else { // hat
        f.type = 'highpass'; f.frequency.value = 6500;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.12, t0 + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0015, t0 + 0.035);
        g.gain.linearRampToValueAtTime(0, t0 + 0.042);
      }
      src.connect(f).connect(g).connect(M.master);
      src.start(t0); src.stop(t0 + 0.1);
    }
  }

  function stepDur() {
    return 60 / (M.track.bpm * M.tempoScale) / 4; // 16th notes
  }

  function scheduleStep(t0) {
    const tr = M.track;
    const sd = stepDur();
    const mel = tr.mel[M.bar][M.step];
    if (mel != null) voice('square', mel, t0, sd * 0.9, 0.14);
    if (tr.harm) {
      const h = tr.harm[M.bar][M.step];
      if (h != null) voice('square', h, t0, sd * 0.85, 0.055);
    }
    const b = tr.bass[M.bar][M.step];
    if (b != null) voice('triangle', b, t0, sd * 1.9, 0.22);
    if (tr.drums) {
      const d = tr.drums[M.bar][M.step];
      if (d) drum(d, t0);
    }
    M.step++;
    if (M.step >= 16) {
      M.step = 0;
      M.bar = (M.bar + 1) % tr.mel.length;
    }
  }

  /* How often the scheduler wakes up, and how far ahead of the clock it queues
     notes. WebAudio plays what it has been given on its own thread, so the only
     job of this timer is to stay comfortably ahead of it — and it was waking
     the main thread 33 times a second to hand over 160ms of music it already
     had 130ms of. Over a battle that is eighty thousand wakeups for nothing,
     and a CPU that is woken ten times a second never gets to sleep properly,
     which is the shape of a battery complaint.

     100ms apart with a 300ms horizon keeps two full intervals of slack — a tick
     can be 200ms late and the music still does not gap — for a third of the
     wakeups. */
  const PUMP_MS = 100, HORIZON = 0.3;

  function pump() {
    if (!M.track || !M.actx) return;
    if (M.actx.state === 'suspended') { M.actx.resume(); return; }
    const now = M.actx.currentTime;
    // If the clock got ahead of us (context was suspended at start, or the tab
    // was throttled), skip forward instead of dumping the backlog as a burst.
    if (M.nextTime < now - 0.04) M.nextTime = now + 0.06;
    const horizon = now + HORIZON;
    while (M.nextTime < horizon) {
      scheduleStep(M.nextTime);
      M.nextTime += stepDur();
    }
  }

  G.music = {
    play(name) {
      if (!TRACKS[name]) return;
      if (M.trackName === name && M.timer) return; // already playing
      if (!ensureCtx()) return;
      if (M.actx.state === 'suspended') M.actx.resume();
      this.stop();
      M.track = TRACKS[name];
      M.trackName = name;
      M.paused = false;
      applyGain();
      M.step = 0; M.bar = 0;
      // start after any already-scheduled notes from the previous track finish,
      // so track switches don't overlap into a smear
      M.nextTime = M.actx.currentTime + 0.18;
      M.timer = setInterval(pump, PUMP_MS);
    },
    stop() {
      if (M.timer) { clearInterval(M.timer); M.timer = null; }
      M.track = null; M.trackName = null;
      M.paused = false;
    },
    /* Pausing the battle pauses the bed. The scheduler stops so no further
       notes are queued, and the gain drops to silence the fraction of a second
       already sitting in the queue — without it, pausing left a bar of music
       playing on into the silence. The track and its position are kept, so
       resume picks up where it stopped rather than restarting. */
    setPaused(paused) {
      paused = !!paused;
      if (M.paused === paused) return;
      M.paused = paused;
      applyGain();
      if (paused) {
        if (M.timer) { clearInterval(M.timer); M.timer = null; }
      } else if (M.track && !M.timer) {
        if (M.actx && M.actx.state === 'suspended') M.actx.resume();
        // don't dump the silent interval's worth of notes as a burst
        if (M.actx) M.nextTime = M.actx.currentTime + 0.06;
        M.timer = setInterval(pump, PUMP_MS);
      }
    },
    setTempoScale(x) {
      /* Ceiling sits just above the wave-75 cap (1.01^74 = 2.086) so the wave
         cap is what actually binds — this is only a backstop against a bad
         caller. Previously 1.8, which silently stopped the music at wave 60. */
      M.tempoScale = Math.max(0.5, Math.min(2.1, x));
    },
    setMuted(muted) {
      M.muted = !!muted;
      applyGain();
    },
    setVolume(v) {
      M.vol = Math.max(0, Math.min(1, Number(v) || 0));
      applyGain();
    },
    getVolume() { return M.vol; },
    trackForLevel(li) {
      return li <= 2 ? 'frost' : li <= 6 ? 'deep' : 'storm';
    },
    state() { return { track: M.trackName, tempoScale: M.tempoScale, playing: !!M.timer }; },
  };
})();
