import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LotteryBall } from './LotteryBall';

interface ScratchRevealProps {
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
  onScratchSound: () => void;
  onRevealed: () => void;
  onClose: (revealed: boolean) => void;
}

const CANVAS = 480; // internal pixels; displayed size is set by CSS
const BRUSH = 48;
const CLEAR_AT = 0.4; // share of foil scratched before the rest lifts off

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const ScratchReveal: React.FC<ScratchRevealProps> = ({
  ballNumber, winner, prize, isRollover, rolloverAmount, drawDate, myNumbers,
  bg, fg, muted, onToggleMute, onScratchSound, onRevealed, onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const downRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const movesRef = useRef(0);
  const doneRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [beat, setBeat] = useState(0); // 0 nothing, 1 "belongs to", 2 name, 3 prize, 4 footer
  const [shared, setShared] = useState(false);

  const isMine = !isRollover && myNumbers.includes(ballNumber);
  const nearest = useMemo(() => {
    if (!myNumbers.length || myNumbers.includes(ballNumber)) return null;
    return myNumbers.reduce((best, n) => (Math.abs(n - ballNumber) < Math.abs(best - ballNumber) ? n : best), myNumbers[0]);
  }, [myNumbers, ballNumber]);

  const dateLabel = useMemo(() => {
    const [y, m, d] = drawDate.split('-').map(Number);
    if (!y || !m || !d) return drawDate;
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }, [drawDate]);

  const line1 = isRollover ? `Ball ${ballNumber} wasn't in this week` : `Ball ${ballNumber} belongs to…`;
  const line2 = isRollover ? 'It rolls over' : isMine ? "It's yours!" : (winner ?? '');
  const line3 = isRollover ? `Next pot starts at £${rolloverAmount}` : isMine ? `You win £${prize}` : `wins £${prize}`;
  const line4 = isMine
    ? 'Carl will be in touch to pay you.'
    : nearest != null
      ? `Your ${nearest} was ${Math.abs(nearest - ballNumber)} away.`
      : '';

  const shareText = isRollover
    ? `Bonus Ball ${dateLabel}: ball ${ballNumber} came up and it wasn't in. £${rolloverAmount} rolls over to next Saturday.`
    : `Bonus Ball ${dateLabel}: ball ${ballNumber} came up. ${winner} wins £${prize}.`;

  // Paint the foil once on mount.
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
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
    return () => timersRef.current.forEach(clearTimeout);
  }, []);

  const reveal = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setRevealed(true);
    try { navigator.vibrate?.([30, 40, 80]); } catch { /* not supported */ }
    onRevealed();
    const gaps = prefersReducedMotion() ? [0, 0, 0, 0] : [600, 1700, 700, 700];
    let at = 0;
    gaps.forEach((gap, i) => {
      at += gap;
      timersRef.current.push(setTimeout(() => setBeat(i + 1), at));
    });
  };

  const checkCleared = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const data = ctx.getImageData(0, 0, CANVAS, CANVAS).data;
    let clear = 0;
    let total = 0;
    for (let i = 3; i < data.length; i += 4 * 29) {
      total++;
      if (data[i] === 0) clear++;
    }
    if (clear / total > CLEAR_AT) reveal();
  };

  const scratchAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (doneRef.current) return;
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) * CANVAS) / r.width;
    const y = ((e.clientY - r.top) * CANVAS) / r.height;
    ctx.globalCompositeOperation = 'destination-out';
    // Join this point to the last one so a fast swipe clears a solid stripe, not dots.
    const from = lastRef.current ?? { x, y };
    ctx.lineWidth = BRUSH * 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, BRUSH, 0, Math.PI * 2);
    ctx.fill();
    lastRef.current = { x, y };
    movesRef.current++;
    if (movesRef.current % 4 === 0) onScratchSound();
    if (movesRef.current % 6 === 0) checkCleared();
  };

  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ text: shareText });
      } else {
        await navigator.clipboard.writeText(shareText);
        setShared(true);
      }
    } catch { /* user cancelled the share sheet */ }
  };

  const confetti = useMemo(
    () =>
      Array.from({ length: 56 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.6,
        duration: 2.4 + Math.random() * 1.6,
        drift: (Math.random() - 0.5) * 120,
        size: 8 + Math.random() * 8,
        color: ['#ffd100', '#ffffff', '#e4007f', '#12a04a', '#1f6fd0', '#6a34b3'][i % 6],
      })),
    []
  );

  const beatCls = (n: number) =>
    `transition-all duration-500 ${beat >= n ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`;

  return (
    <div className="fixed inset-0 z-[1000] overflow-hidden flex flex-col items-center" style={{ background: bg, color: fg }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `@keyframes scratchConfetti{0%{transform:translate3d(0,-10vh,0) rotate(0)}100%{transform:translate3d(var(--drift),110vh,0) rotate(720deg);opacity:.8}}
          @keyframes scratchPop{0%{transform:scale(1)}40%{transform:scale(1.12)}100%{transform:scale(1)}}`,
        }}
      />
      {beat >= 2 && !isRollover && !prefersReducedMotion() && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {confetti.map((p, i) => (
            <span
              key={i}
              className="absolute top-0 rounded-sm"
              style={{
                left: `${p.left}%`, width: p.size, height: p.size * 0.45, background: p.color,
                animation: `scratchConfetti ${p.duration}s linear ${p.delay}s forwards`,
                ['--drift' as any]: `${p.drift}px`,
              }}
            />
          ))}
        </div>
      )}

      <div className="relative w-full max-w-md flex items-center justify-between px-5 pt-5">
        <button onClick={() => onClose(revealed)} aria-label="Close" className="w-10 h-10 rounded-full bg-black/15 text-lg font-bold">✕</button>
        <button onClick={onToggleMute} className="px-3 h-10 rounded-full bg-black/15 text-sm font-bold">{muted ? 'Sound off' : 'Sound on'}</button>
      </div>

      <div className="relative flex-1 w-full max-w-md flex flex-col items-center justify-center px-6 pb-6 text-center">
        <p className="text-base font-bold opacity-90">Saturday draw, {dateLabel}</p>
        <h2 className="text-3xl font-extrabold tracking-tight mt-1 mb-6">
          {revealed ? `Ball ${ballNumber}` : 'The ball is in'}
        </h2>

        <div
          className="relative"
          style={{
            width: 'min(62vw, 250px)', height: 'min(62vw, 250px)',
            animation: revealed && !prefersReducedMotion() ? 'scratchPop .6s ease-out' : undefined,
          }}
        >
          <LotteryBall number={ballNumber} className="w-full h-full" />
          <canvas
            ref={canvasRef}
            width={CANVAS}
            height={CANVAS}
            aria-label="Gold foil. Scratch it off to see the ball."
            className={`absolute inset-0 z-20 w-full h-full rounded-full cursor-grab transition-opacity duration-500 ${revealed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
            style={{ touchAction: 'none' }}
            onPointerDown={(e) => { downRef.current = true; lastRef.current = null; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } scratchAt(e); }}
            onPointerMove={(e) => { if (downRef.current) scratchAt(e); }}
            onPointerUp={() => { downRef.current = false; if (!doneRef.current) checkCleared(); }}
            onPointerCancel={() => { downRef.current = false; }}
          />
        </div>

        {!revealed ? (
          <div className="mt-6">
            <p className="text-base font-semibold">Scratch the gold off with your finger.</p>
            {myNumbers.length > 0 && (
              <p className="text-sm opacity-80 mt-1">You have {myNumbers.length === 1 ? 'ball' : 'balls'} {myNumbers.join(', ')}.</p>
            )}
            <button onClick={reveal} className="mt-4 text-sm font-bold underline underline-offset-4 opacity-90">Reveal it for me</button>
          </div>
        ) : (
          <div className="mt-6 min-h-[9.5rem] flex flex-col items-center">
            <p className={`text-base font-semibold ${beatCls(1)}`}>{line1}</p>
            <p className={`text-4xl font-extrabold tracking-tight leading-tight mt-1 ${beatCls(2)}`}>{line2}</p>
            <p className={`text-2xl font-extrabold mt-1 ${beatCls(3)}`}>{line3}</p>
            {line4 && <p className={`text-sm opacity-85 mt-2 ${beatCls(4)}`}>{line4}</p>}
          </div>
        )}

        <div className={`w-full flex gap-3 mt-6 ${beatCls(4)} ${beat >= 4 ? '' : 'pointer-events-none'}`}>
          <button onClick={share} className="flex-1 py-3.5 rounded-2xl bg-black/15 font-extrabold">{shared ? 'Copied' : 'Share'}</button>
          <button onClick={() => onClose(true)} className="flex-1 py-3.5 rounded-2xl bg-white text-[#14161c] font-extrabold">Done</button>
        </div>
      </div>
    </div>
  );
};
