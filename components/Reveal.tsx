import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LotteryBall } from './LotteryBall';

// Every reveal shares one shell: a stage that hides the ball in its own way, then the same
// three beats once the ball lands (number, "belongs to…", name and prize).

export type RevealKind = 'scratch' | 'machine' | 'cups' | 'clues' | 'balloon' | 'knockout' | 'envelope';
export type SoundKind = 'tick' | 'pop' | 'whoosh' | 'drum' | 'tone';

export const REVEAL_KINDS: { value: RevealKind; label: string; desc: string; hint: string }[] = [
  { value: 'scratch', label: 'Scratch Off', desc: 'Scratch the gold off the ball with your finger', hint: 'Scratch the gold off with your finger.' },
  { value: 'machine', label: 'The Machine', desc: 'Balls tumble in the drum and one drops out', hint: 'Start the machine and watch one drop.' },
  { value: 'cups', label: 'Pick a Cup', desc: 'Three cups shuffle. Tap one to lift it', hint: 'Watch the cups, then pick one.' },
  { value: 'clues', label: 'Clue by Clue', desc: 'Colour first, then two clues, then the number', hint: 'Three clues, then the number.' },
  { value: 'balloon', label: 'Pump the Balloon', desc: 'Tap to pump it up until it bursts', hint: 'Keep tapping the balloon until it bursts.' },
  { value: 'knockout', label: 'Last Ball Standing', desc: 'All 59 on the board, knocked out down to one', hint: 'All 59 start. Only one is left standing.' },
  { value: 'envelope', label: 'Golden Envelope', desc: 'Tap the envelope to open it, awards-night style', hint: 'Tap the envelope to open it.' },
];

interface StageProps {
  n: number;
  mine: number[];
  onLand: () => void;
  sound: (kind: SoundKind, freq?: number) => void;
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const useTimers = () => {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
};

const startBtn = 'rounded-2xl bg-white text-[#14161c] font-extrabold px-6 py-3.5 shadow-lg active:scale-95 transition';
const GOLD = 'linear-gradient(135deg,#ffe58a 0%,#e9b22e 45%,#fff0b0 70%,#d99a1c 100%)';

/* ------------------------------ Scratch Off ------------------------------ */
const CANVAS = 480;
const BRUSH = 48;

const ScratchStage: React.FC<StageProps> = ({ n, onLand, sound }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const down = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const moves = useRef(0);
  const done = useRef(false);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const g = ctx.createLinearGradient(0, 0, CANVAS, CANVAS);
    g.addColorStop(0, '#ffe58a');
    g.addColorStop(0.45, '#e9b22e');
    g.addColorStop(0.7, '#fff0b0');
    g.addColorStop(1, '#d99a1c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CANVAS, CANVAS);
    ctx.fillStyle = 'rgba(70,45,0,.75)';
    ctx.font = '800 46px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SCRATCH', CANVAS / 2, CANVAS / 2 + 16);
  }, []);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    onLand();
  };
  const check = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const data = ctx.getImageData(0, 0, CANVAS, CANVAS).data;
    let clear = 0;
    let total = 0;
    for (let i = 3; i < data.length; i += 4 * 29) {
      total++;
      if (data[i] === 0) clear++;
    }
    if (clear / total > 0.4) finish();
  };
  const scratch = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (done.current) return;
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) * CANVAS) / r.width;
    const y = ((e.clientY - r.top) * CANVAS) / r.height;
    ctx.globalCompositeOperation = 'destination-out';
    // Join this point to the last one so a fast swipe clears a solid stripe, not dots.
    const from = last.current ?? { x, y };
    ctx.lineWidth = BRUSH * 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, BRUSH, 0, Math.PI * 2);
    ctx.fill();
    last.current = { x, y };
    moves.current++;
    if (moves.current % 4 === 0) sound('tick');
    if (moves.current % 6 === 0) check();
  };

  return (
    <div className="relative" style={{ width: 'min(62vw, 250px)', height: 'min(62vw, 250px)' }}>
      <LotteryBall number={n} className="w-full h-full" />
      <canvas
        ref={canvasRef}
        width={CANVAS}
        height={CANVAS}
        aria-label="Gold foil. Scratch it off to see the ball."
        className="absolute inset-0 z-20 w-full h-full rounded-full cursor-grab"
        style={{ touchAction: 'none' }}
        onPointerDown={(e) => { down.current = true; last.current = null; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } scratch(e); }}
        onPointerMove={(e) => { if (down.current) scratch(e); }}
        onPointerUp={() => { down.current = false; if (!done.current) check(); }}
        onPointerCancel={() => { down.current = false; }}
      />
    </div>
  );
};

/* ------------------------------ The Machine ------------------------------ */
const DRUM = 220;
const BALL = 30;

const MachineStage: React.FC<StageProps> = ({ n, onLand, sound }) => {
  const [phase, setPhase] = useState<'idle' | 'spin' | 'drop' | 'wobble'>('idle');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const after = useTimers();
  const els = useRef<(HTMLDivElement | null)[]>([]);
  const numbers = useMemo(() => {
    const pool = Array.from({ length: 59 }, (_, i) => i + 1).filter((x) => x !== n);
    return pool.sort(() => Math.random() - 0.5).slice(0, 14);
  }, [n]);

  useEffect(() => {
    const R = DRUM / 2;
    const r = BALL / 2;
    const state = numbers.map((_, i) => ({
      x: R + Math.cos(i * 2.4) * (20 + ((i * 37) % 60)),
      y: R + 40 + Math.sin(i * 2.4) * 20,
      vx: 0,
      vy: 0,
    }));
    let raf = 0;
    let frame = 0;
    const step = () => {
      const spinning = phaseRef.current !== 'idle';
      frame++;
      state.forEach((b, i) => {
        b.vy += 0.14;
        if (spinning) {
          b.vx += (Math.random() - 0.5) * 0.6;
          b.vy += (Math.random() - 0.5) * 0.6;
        } else {
          b.vx *= 0.96;
          b.vy *= 0.96;
        }
        b.x += b.vx;
        b.y += b.vy;
        const dx = b.x - R;
        const dy = b.y - R;
        const dist = Math.hypot(dx, dy) || 1;
        const max = R - r - 4;
        if (dist > max) {
          const nx = dx / dist;
          const ny = dy / dist;
          b.x = R + nx * max;
          b.y = R + ny * max;
          const dot = b.vx * nx + b.vy * ny;
          b.vx -= 2 * dot * nx;
          b.vy -= 2 * dot * ny;
          if (spinning) {
            // the paddle: a push along the wall keeps them tumbling
            b.vx += -ny * 1.2;
            b.vy += nx * 1.2;
          } else {
            b.vx *= 0.5;
            b.vy *= 0.5;
          }
        }
        const speed = Math.hypot(b.vx, b.vy);
        if (speed > 6) {
          b.vx *= 6 / speed;
          b.vy *= 6 / speed;
        }
        const el = els.current[i];
        if (el) el.style.transform = `translate(${b.x - r}px, ${b.y - r}px)`;
      });
      if (spinning && phaseRef.current === 'spin' && frame % 9 === 0) sound('tick');
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [numbers]);

  const start = () => {
    setPhase('spin');
    after(() => { setPhase('drop'); sound('whoosh'); }, 3200);
    after(() => setPhase('wobble'), 4300);
    after(onLand, 5600);
  };

  const out = phase === 'drop' || phase === 'wobble';
  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <style dangerouslySetInnerHTML={{ __html: '@keyframes revealWobble{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}' }} />
      <div className={`relative transition-all duration-700 ${out ? 'opacity-0 scale-75' : 'opacity-100'}`} style={{ width: DRUM, height: DRUM }}>
        <div className="absolute inset-0 rounded-full border-4 border-white/60 bg-white/10" />
        {numbers.map((num, i) => (
          <div key={num} ref={(el) => { els.current[i] = el; }} className="absolute left-0 top-0" style={{ width: BALL, height: BALL }}>
            <LotteryBall number={num} hideShadow className="w-full h-full" />
          </div>
        ))}
        <div className="absolute left-1/2 -translate-x-1/2 -bottom-6 w-11 h-7 border-4 border-t-0 border-white/60 rounded-b-xl" />
      </div>
      <div
        className="absolute transition-all ease-out"
        style={{
          width: 'min(62vw, 250px)', height: 'min(62vw, 250px)',
          transitionDuration: '900ms',
          opacity: out ? 1 : 0,
          transform: out ? 'translateY(0) scale(1)' : 'translateY(130px) scale(0.15)',
        }}
      >
        <div className="w-full h-full" style={{ animation: phase === 'wobble' ? 'revealWobble .45s ease-in-out infinite' : undefined }}>
          <LotteryBall number={n} showNumber={false} className="w-full h-full" />
        </div>
      </div>
      {phase === 'idle' && <button onClick={start} className={`absolute ${startBtn}`}>Start the machine</button>}
    </div>
  );
};

/* ------------------------------ Pick a Cup ------------------------------ */
const CUP_SLOTS = [-92, 0, 92];

const CupsStage: React.FC<StageProps> = ({ n, onLand, sound }) => {
  const [phase, setPhase] = useState<'show' | 'cover' | 'shuffle' | 'pick' | 'lift'>('show');
  const [slots, setSlots] = useState([0, 1, 2]); // slots[cup] = position index
  const [picked, setPicked] = useState<number | null>(null);
  const after = useTimers();

  useEffect(() => {
    after(() => setPhase('cover'), 1100);
    after(() => setPhase('shuffle'), 1700);
    const swaps = 7;
    for (let i = 0; i < swaps; i++) {
      after(() => {
        setSlots((prev) => {
          const a = Math.floor(Math.random() * 3);
          const b = (a + 1 + Math.floor(Math.random() * 2)) % 3;
          const next = [...prev];
          [next[a], next[b]] = [next[b], next[a]];
          return next;
        });
        sound('whoosh');
      }, 1900 + i * 400);
    }
    after(() => setPhase('pick'), 1900 + swaps * 400 + 200);
  }, []);

  const pick = (cup: number) => {
    if (phase !== 'pick') return;
    setPicked(cup);
    setPhase('lift');
    sound('pop');
    after(onLand, 1100);
  };

  const ballSlot = phase === 'lift' && picked != null ? slots[picked] : 1;
  const ballVisible = phase === 'show' || phase === 'lift';
  return (
    <div className="relative w-full h-full">
      <p className="absolute top-2 inset-x-0 text-center font-extrabold text-lg">
        {phase === 'pick' ? 'Tap a cup' : phase === 'lift' ? 'There it is…' : 'Keep your eye on it'}
      </p>
      <div className="absolute left-1/2 bottom-12 transition-opacity duration-200" style={{ width: 62, height: 62, marginLeft: -31, transform: `translateX(${CUP_SLOTS[ballSlot]}px)`, opacity: ballVisible ? 1 : 0 }}>
        <LotteryBall number={n} showNumber={false} hideShadow className="w-full h-full" />
      </div>
      {[0, 1, 2].map((cup) => {
        const lifted = phase === 'show' || (phase === 'lift' && picked === cup);
        return (
          <button
            key={cup}
            aria-label={`Cup ${cup + 1}`}
            onClick={() => pick(cup)}
            className="absolute left-1/2 bottom-10"
            style={{
              width: 84, height: 104, marginLeft: -42,
              transform: `translateX(${CUP_SLOTS[slots[cup]]}px) translateY(${lifted ? -84 : 0}px)`,
              transition: 'transform .36s ease-in-out',
            }}
          >
            <span className="block w-full h-full" style={{ background: GOLD, clipPath: 'polygon(20% 0, 80% 0, 100% 100%, 0 100%)', filter: 'drop-shadow(0 6px 8px rgba(0,0,0,.25))' }} />
          </button>
        );
      })}
    </div>
  );
};

/* ------------------------------ Clue by Clue ------------------------------ */
const BANDS = [
  { lo: 1, hi: 9, name: 'White' },
  { lo: 10, hi: 19, name: 'Blue' },
  { lo: 20, hi: 29, name: 'Pink' },
  { lo: 30, hi: 39, name: 'Green' },
  { lo: 40, hi: 49, name: 'Yellow' },
  { lo: 50, hi: 59, name: 'Purple' },
];

const CluesStage: React.FC<StageProps> = ({ n, mine, onLand, sound }) => {
  const [step, setStep] = useState(0); // 0 waiting, 1-3 clues shown
  const after = useTimers();
  const band = BANDS.find((b) => n >= b.lo && n <= b.hi)!;
  const mid = band.lo === 1 ? 5 : band.lo + 5;

  const clues = useMemo(() => {
    const inBand = (x: number) => x >= band.lo && x <= band.hi;
    const parity = (x: number) => x % 2 === n % 2;
    const half = (x: number) => (n >= mid ? x >= mid : x < mid);
    return [
      { text: `It's a ${band.name.toLowerCase()} ball.`, sub: `That's ${band.lo} to ${band.hi}.`, test: (x: number) => inBand(x) },
      { text: n % 2 ? "It's an odd number." : "It's an even number.", sub: '', test: (x: number) => inBand(x) && parity(x) },
      { text: n >= mid ? `It's ${mid} or higher.` : `It's lower than ${mid}.`, sub: '', test: (x: number) => inBand(x) && parity(x) && half(x) },
    ];
  }, [n]);

  const start = () => {
    const gap = reducedMotion() ? 900 : 2500;
    [1, 2, 3].forEach((s, i) => after(() => { setStep(s); sound('drum'); }, 300 + i * gap));
    after(onLand, 300 + 3 * gap);
  };

  const current = step > 0 ? clues[step - 1] : null;
  const left = current ? Array.from({ length: 59 }, (_, i) => i + 1).filter(current.test) : [];
  const stillIn = current ? mine.filter(current.test) : [];
  const status = !current || mine.length === 0
    ? ''
    : stillIn.length > 0
      ? `Your ${stillIn.join(' and ')} ${stillIn.length === 1 ? 'is' : 'are'} still in it!`
      : "You're out of this one.";

  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center gap-3">
      <div className="relative" style={{ width: 150, height: 150 }}>
        {step === 0 ? (
          <div className="w-full h-full rounded-full bg-black/15 border-4 border-white/50" />
        ) : (
          <LotteryBall number={n} showNumber={false} className="w-full h-full" />
        )}
        <span className="absolute inset-0 z-20 flex items-center justify-center text-6xl font-extrabold" style={{ color: step > 0 && (band.name === 'White' || band.name === 'Yellow') ? '#14161c' : '#ffffff' }}>?</span>
      </div>
      {step === 0 ? (
        <button onClick={start} className={startBtn}>Give me the first clue</button>
      ) : (
        <div key={step} className="text-center" style={{ animation: 'revealClue .5s ease-out' }}>
          <style dangerouslySetInnerHTML={{ __html: '@keyframes revealClue{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' }} />
          <p className="text-sm font-bold opacity-80">Clue {step} of 3</p>
          <p className="text-2xl font-extrabold leading-tight">{current!.text}</p>
          <p className="font-semibold opacity-90">{current!.sub} {left.length} ball{left.length === 1 ? '' : 's'} left.</p>
          {status && <p className="mt-1 font-extrabold">{status}</p>}
        </div>
      )}
    </div>
  );
};

/* ------------------------------ Pump the Balloon ------------------------------ */
const PUMPS = 7;

const BalloonStage: React.FC<StageProps> = ({ onLand, sound }) => {
  const [taps, setTaps] = useState(0);
  const [burst, setBurst] = useState(false);
  const after = useTimers();

  const pump = () => {
    if (burst) return;
    const next = taps + 1;
    setTaps(next);
    if (next >= PUMPS) {
      setBurst(true);
      sound('pop');
      try { navigator.vibrate?.(60); } catch { /* not supported */ }
      after(onLand, 380);
    } else {
      sound('tone', 280 + next * 70);
    }
  };

  const scale = 0.55 + taps * 0.11;
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-end pb-2">
      <style dangerouslySetInnerHTML={{ __html: '@keyframes revealSway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}' }} />
      <button aria-label="Pump the balloon" onClick={pump} className="relative flex-1 w-full flex items-end justify-center">
        <span className="block origin-bottom" style={{ animation: 'revealSway 2.4s ease-in-out infinite' }}>
          <span
            className="block origin-bottom"
            style={{
              transform: `scale(${burst ? scale * 1.6 : scale})`,
              opacity: burst ? 0 : 1,
              transition: burst ? 'transform .25s ease-out, opacity .25s' : 'transform .25s cubic-bezier(.3,1.6,.5,1)',
            }}
          >
            <span className="block mx-auto" style={{ width: 150, height: 180, borderRadius: '50%', background: 'radial-gradient(circle at 32% 28%, #fff6c9 0%, #f2c230 38%, #d1931a 100%)', boxShadow: 'inset -10px -14px 24px rgba(0,0,0,.18)' }} />
            <span className="block mx-auto" style={{ width: 0, height: 0, borderLeft: '9px solid transparent', borderRight: '9px solid transparent', borderBottom: '12px solid #d1931a', marginTop: -2 }} />
            <span className="block mx-auto bg-white/70" style={{ width: 2, height: 46 }} />
          </span>
        </span>
      </button>
      <p className="font-extrabold">{burst ? 'Bang!' : taps === 0 ? 'Tap to pump' : `Keep going… ${taps} of ${PUMPS}`}</p>
    </div>
  );
};

/* ------------------------------ Last Ball Standing ------------------------------ */
const KnockoutStage: React.FC<StageProps> = ({ n, mine, onLand, sound }) => {
  const [out, setOut] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState(false);
  const after = useTimers();
  const order = useMemo(
    () => Array.from({ length: 59 }, (_, i) => i + 1).filter((x) => x !== n).sort(() => Math.random() - 0.5),
    [n]
  );

  const start = () => {
    setRunning(true);
    const targets = [36, 18, 8, 3, 2, 1]; // how many are left after each wave
    const gaps = reducedMotion() ? [300, 300, 300, 300, 300, 300] : [500, 1200, 1300, 1600, 2000, 2200];
    let at = 0;
    targets.forEach((left, i) => {
      at += gaps[i];
      after(() => {
        setOut(new Set(order.slice(0, 59 - left)));
        sound(left <= 3 ? 'pop' : 'drum');
      }, at);
    });
    after(onLand, at + 1300);
  };

  const left = 59 - out.size;
  const stillIn = mine.filter((x) => !out.has(x));
  const status = !running || mine.length === 0
    ? ''
    : stillIn.length > 0
      ? `Your ${stillIn.join(' and ')} ${stillIn.length === 1 ? 'is' : 'are'} still standing!`
      : "You're out of this one.";

  return (
    <div className="relative w-full h-full flex flex-col items-center">
      <p className="font-extrabold text-lg h-7">{running ? (left === 1 ? 'One left…' : `${left} left`) : 'All 59 are in'}</p>
      <div className="grid grid-cols-9 gap-1 w-full flex-1 content-start mt-1">
        {Array.from({ length: 59 }, (_, i) => i + 1).map((num) => (
          <div
            key={num}
            className={`rounded-full transition-all duration-500 ${out.has(num) ? 'opacity-0 scale-0' : 'opacity-100 scale-100'} ${mine.includes(num) ? 'ring-2 ring-white ring-offset-1 ring-offset-transparent' : ''}`}
          >
            <LotteryBall number={num} hideShadow className="w-full" />
          </div>
        ))}
      </div>
      {running ? <p className="font-extrabold h-6">{status}</p> : <button onClick={start} className={`absolute top-1/2 -translate-y-1/2 ${startBtn}`}>Start the knockout</button>}
    </div>
  );
};

/* ------------------------------ Golden Envelope ------------------------------ */
const EnvelopeStage: React.FC<StageProps> = ({ onLand, sound }) => {
  const [open, setOpen] = useState(false);
  const after = useTimers();
  const tap = () => {
    if (open) return;
    setOpen(true);
    sound('whoosh');
    after(() => sound('drum'), 900);
    after(onLand, reducedMotion() ? 900 : 2600);
  };
  return (
    <button aria-label="Open the envelope" onClick={tap} className="relative w-full h-full flex items-end justify-center pb-8" style={{ perspective: 700 }}>
      <span className="relative block" style={{ width: 240, height: 160 }}>
        {/* the card */}
        <span
          className="absolute left-4 right-4 bg-white text-[#14161c] rounded-lg flex flex-col items-center justify-start pt-5 text-center px-3 shadow-lg"
          style={{ height: 150, bottom: 6, transform: open ? 'translateY(-112px)' : 'translateY(0)', transition: 'transform .9s cubic-bezier(.3,1.2,.5,1) .35s' }}
        >
          <span className="text-xs font-bold text-[#5a6270]">Saturday draw</span>
          <span className="text-xl font-extrabold leading-tight">And the bonus ball is…</span>
        </span>
        {/* envelope front */}
        <span className="absolute inset-0 rounded-lg" style={{ background: GOLD, clipPath: 'polygon(0 0, 50% 52%, 100% 0, 100% 100%, 0 100%)', filter: 'drop-shadow(0 8px 10px rgba(0,0,0,.25))' }} />
        {/* flap */}
        <span
          className="absolute inset-x-0 top-0"
          style={{
            height: 96, background: 'linear-gradient(180deg,#d99a1c,#f2c230)', clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
            transformOrigin: 'top', transform: open ? 'rotateX(180deg)' : 'rotateX(0)', transition: 'transform .45s ease-in, opacity .2s ease-in .3s', opacity: open ? 0 : 1,
          }}
        />
      </span>
      {!open && <span className="absolute bottom-0 inset-x-0 text-center font-extrabold">Tap to open</span>}
    </button>
  );
};

const STAGES: Record<RevealKind, React.FC<StageProps>> = {
  scratch: ScratchStage,
  machine: MachineStage,
  cups: CupsStage,
  clues: CluesStage,
  balloon: BalloonStage,
  knockout: KnockoutStage,
  envelope: EnvelopeStage,
};

/* ------------------------------ Shared shell ------------------------------ */
interface RevealProps {
  kind: RevealKind;
  ballNumber: number;
  winner: string | null;
  prize: number;
  isRollover: boolean;
  rolloverAmount: number;
  drawDate: string; // YYYY-MM-DD
  myNumbers: number[];
  bg: string;
  fg: string;
  muted: boolean;
  onToggleMute: () => void;
  onSound: (kind: SoundKind, freq?: number) => void;
  onRevealed: () => void;
  onClose: (revealed: boolean) => void;
}

export const Reveal: React.FC<RevealProps> = ({
  kind, ballNumber, winner, prize, isRollover, rolloverAmount, drawDate, myNumbers,
  bg, fg, muted, onToggleMute, onSound, onRevealed, onClose,
}) => {
  const [landed, setLanded] = useState(false);
  const landedRef = useRef(false);
  const [beat, setBeat] = useState(0); // 1 "belongs to", 2 name, 3 prize, 4 footer
  const [shared, setShared] = useState(false);
  const after = useTimers();
  const Stage = STAGES[kind] ?? ScratchStage;
  const meta = REVEAL_KINDS.find((k) => k.value === kind) ?? REVEAL_KINDS[0];

  const isMine = !isRollover && myNumbers.includes(ballNumber);
  const nearest = useMemo(() => {
    if (!myNumbers.length || myNumbers.includes(ballNumber)) return null;
    return myNumbers.reduce((best, x) => (Math.abs(x - ballNumber) < Math.abs(best - ballNumber) ? x : best), myNumbers[0]);
  }, [myNumbers, ballNumber]);
  const dateLabel = useMemo(() => {
    const [y, m, d] = drawDate.split('-').map(Number);
    if (!y || !m || !d) return drawDate;
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }, [drawDate]);

  const line1 = isRollover ? `Ball ${ballNumber} wasn't in this week` : `Ball ${ballNumber} belongs to…`;
  const line2 = isRollover ? 'It rolls over' : isMine ? "It's yours!" : (winner ?? '');
  const line3 = isRollover ? `Next pot starts at £${rolloverAmount}` : isMine ? `You win £${prize}` : `wins £${prize}`;
  const line4 = isMine ? 'Carl will be in touch to pay you.' : nearest != null ? `Your ${nearest} was ${Math.abs(nearest - ballNumber)} away.` : '';
  const shareText = isRollover
    ? `Bonus Ball ${dateLabel}: ball ${ballNumber} came up and it wasn't in. £${rolloverAmount} rolls over to next Saturday.`
    : `Bonus Ball ${dateLabel}: ball ${ballNumber} came up. ${winner} wins £${prize}.`;

  const land = () => {
    if (landedRef.current) return;
    landedRef.current = true;
    setLanded(true);
    try { navigator.vibrate?.([30, 40, 80]); } catch { /* not supported */ }
    onRevealed();
    const gaps = reducedMotion() ? [0, 0, 0, 0] : [600, 1700, 700, 700];
    let at = 0;
    gaps.forEach((gap, i) => {
      at += gap;
      after(() => setBeat(i + 1), at);
    });
  };

  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ text: shareText });
      else {
        await navigator.clipboard.writeText(shareText);
        setShared(true);
      }
    } catch { /* user cancelled the share sheet */ }
  };

  const confetti = useMemo(
    () => Array.from({ length: 56 }, (_, i) => ({
      left: Math.random() * 100, delay: Math.random() * 0.6, duration: 2.4 + Math.random() * 1.6,
      drift: (Math.random() - 0.5) * 120, size: 8 + Math.random() * 8,
      color: ['#ffd100', '#ffffff', '#e4007f', '#12a04a', '#1f6fd0', '#6a34b3'][i % 6],
    })),
    []
  );
  const beatCls = (b: number) => `transition-all duration-500 ${beat >= b ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`;

  return (
    <div className="fixed inset-0 z-[1000] overflow-hidden flex flex-col items-center" style={{ background: bg, color: fg }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `@keyframes revealConfetti{0%{transform:translate3d(0,-10vh,0) rotate(0)}100%{transform:translate3d(var(--drift),110vh,0) rotate(720deg);opacity:.8}}
          @keyframes revealPop{0%{transform:scale(.8)}45%{transform:scale(1.12)}100%{transform:scale(1)}}`,
        }}
      />
      {beat >= 2 && !isRollover && !reducedMotion() && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {confetti.map((p, i) => (
            <span key={i} className="absolute top-0 rounded-sm" style={{ left: `${p.left}%`, width: p.size, height: p.size * 0.45, background: p.color, animation: `revealConfetti ${p.duration}s linear ${p.delay}s forwards`, ['--drift' as any]: `${p.drift}px` }} />
          ))}
        </div>
      )}

      <div className="relative w-full max-w-md flex items-center justify-between px-5 pt-5">
        <button onClick={() => onClose(landed)} aria-label="Close" className="w-10 h-10 rounded-full bg-black/15 text-lg font-bold">✕</button>
        <button onClick={onToggleMute} className="px-3 h-10 rounded-full bg-black/15 text-sm font-bold">{muted ? 'Sound off' : 'Sound on'}</button>
      </div>

      <div className="relative flex-1 w-full max-w-md flex flex-col items-center justify-center px-6 pb-6 text-center">
        <p className="text-base font-bold opacity-90">Saturday draw, {dateLabel}</p>
        <h2 className="text-3xl font-extrabold tracking-tight mt-1 mb-4">{landed ? `Ball ${ballNumber}` : 'The ball is in'}</h2>

        <div className="relative flex items-center justify-center" style={{ width: 'min(84vw, 310px)', height: 'min(84vw, 310px)' }}>
          {landed ? (
            <div style={{ width: 'min(62vw, 250px)', height: 'min(62vw, 250px)', animation: reducedMotion() ? undefined : 'revealPop .6s ease-out' }}>
              <LotteryBall number={ballNumber} className="w-full h-full" />
            </div>
          ) : (
            <Stage n={ballNumber} mine={myNumbers} onLand={land} sound={onSound} />
          )}
        </div>

        {!landed ? (
          <div className="mt-4">
            <p className="text-base font-semibold">{meta.hint}</p>
            {myNumbers.length > 0 && <p className="text-sm opacity-80 mt-1">You have {myNumbers.length === 1 ? 'ball' : 'balls'} {myNumbers.join(', ')}.</p>}
            <button onClick={land} className="mt-3 text-sm font-bold underline underline-offset-4 opacity-90">Just show me</button>
          </div>
        ) : (
          <div className="mt-4 min-h-[9.5rem] flex flex-col items-center">
            <p className={`text-base font-semibold ${beatCls(1)}`}>{line1}</p>
            <p className={`text-4xl font-extrabold tracking-tight leading-tight mt-1 ${beatCls(2)}`}>{line2}</p>
            <p className={`text-2xl font-extrabold mt-1 ${beatCls(3)}`}>{line3}</p>
            {line4 && <p className={`text-sm opacity-85 mt-2 ${beatCls(4)}`}>{line4}</p>}
          </div>
        )}

        <div className={`w-full flex gap-3 mt-4 ${beatCls(4)} ${beat >= 4 ? '' : 'pointer-events-none'}`}>
          <button onClick={share} className="flex-1 py-3.5 rounded-2xl bg-black/15 font-extrabold">{shared ? 'Copied' : 'Share'}</button>
          <button onClick={() => onClose(true)} className="flex-1 py-3.5 rounded-2xl bg-white text-[#14161c] font-extrabold">Done</button>
        </div>
      </div>
    </div>
  );
};
