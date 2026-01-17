
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LotteryBall } from './components/LotteryBall';
import { supabase } from "./services/supabase";



interface BallState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  num: number;
  isWinner?: boolean;
}

interface BallOwnerDetails {
  name: string;
  email?: string; 
  paidUntil: string;
  nextDue: string;
  status: 'paid' | 'overdue' | 'lifetime';
}

interface DrawResult {
  date: string;
  ballNumber: number;
  winner: string;
  prizeAmount: number;
  charityAmount: number;
}

interface NotificationMessage {
  id: string;
  title: string;
  body: string;
  timestamp: string;
  type: 'blast' | 'reminder' | 'win';
  target: string;
  read: boolean;
}

type Tab = 'home' | 'balls' | 'winners' | 'admin';

const ADMIN_EMAIL = 'Carlwhalliday@icloud.com';
const TEST_EMAIL = 'test@user.com';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [showWinReveal, setShowWinReveal] = useState(false);
  
  // Modals / Admin State
  const [adminAction, setAdminAction] = useState<{type: 'assign' | 'result' | 'payment', ballNum?: number} | null>(null);
  const [assignmentName, setAssignmentName] = useState('');
  const [resultBallNum, setResultBallNum] = useState('');
  const [paymentWeeks, setPaymentWeeks] = useState('1');
  
  const [revealStep, setRevealStep] = useState<'searching' | 'tracking' | 'homing' | 'settled' | 'idle'>('idle');
  const [revealBalls, setRevealBalls] = useState<BallState[]>([]);
  const [spotlightPos, setSpotlightPos] = useState({ x: 0, y: 0 });

  const revealRef = useRef<BallState[]>([]);
  const spotlightRef = useRef({ x: 0, y: 0 });
  const revealRequestRef = useRef<number>(null);

  const [smallBalls, setSmallBalls] = useState<BallState[]>([]);
  const [selectedBallNum, setSelectedBallNum] = useState<number | null>(null);

  // PLATFORM STATE - STARTING BLANK
  const [notifications, setNotifications] = useState<NotificationMessage[]>([]);
  const [blastMessage, setBlastMessage] = useState('');
  const [blastTarget, setBlastTarget] = useState<'all' | 'unpaid' | 'specific'>('all');
  const [showInbox, setShowInbox] = useState(false);
  const [isTransmitting, setIsTransmitting] = useState(false);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [adminSearchTerm, setAdminSearchTerm] = useState('');
  const requestRef = useRef<number>(null);

  const [managedBallData, setManagedBallData] = useState<Record<number, BallOwnerDetails>>({});
  const [pastResults, setPastResults] = useState<DrawResult[]>([]);
  const [totalRollover, setTotalRollover] = useState(0);

  // DYNAMIC CALCULATIONS
  const isAdmin = useMemo(() => userEmail.toLowerCase() === ADMIN_EMAIL.toLowerCase(), [userEmail]);
  const paidCount = useMemo(() => Object.values(managedBallData).filter(b => b.status === 'paid' || b.status === 'lifetime').length, [managedBallData]);
  const currentPot = useMemo(() => totalRollover + (paidCount * 2), [totalRollover, paidCount]);
  const totalRaised = useMemo(() => pastResults.reduce((acc, curr) => acc + curr.charityAmount, 0), [pastResults]);

  const defaultNextDraw = useMemo(() => {
    const now = new Date();
    const resultDate = new Date(now.getTime());
    resultDate.setDate(now.getDate() + (7 + 6 - now.getDay()) % 7);
    if (now.getDay() === 6 && now.getHours() >= 20) {
      resultDate.setDate(resultDate.getDate() + 7);
    }
    return resultDate.toISOString().split('T')[0];
  }, []);
  const [nextDrawRawDate] = useState(defaultNextDraw);

  const formattedDrawDate = useMemo(() => {
    return new Date(nextDrawRawDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }, [nextDrawRawDate]);

  const latestWin = pastResults.length > 0 ? pastResults[0] : null;

  // HANDLERS
  const handleLogin = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const emailInput = formData.get('email') as string;
    // Handle browser autocomplete or empty state correctly
    const finalEmail = emailInput || (isRegistering ? '' : ADMIN_EMAIL);
    setUserEmail(finalEmail);
    setIsLoggedIn(true);
    if (latestWin) checkReveal();
  };

  const handleRegister = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const emailInput = formData.get('email') as string;
    setUserEmail(emailInput);
    setIsLoggedIn(true);
    sendPush("Welcome", "Your account has been successfully created.", "admin", "reminder");
  };

  const checkReveal = () => {
    const now = new Date();
    const day = now.getDay();
    const hrs = now.getHours();
    const mins = now.getMinutes();

    let lastDrawSat = new Date(now);
    const diff = (day + 1) % 7;
    lastDrawSat.setDate(now.getDate() - diff);
    lastDrawSat.setHours(20, 10, 0, 0);

    if (day === 6 && (hrs < 20 || (hrs === 20 && mins < 10))) {
      lastDrawSat.setDate(lastDrawSat.getDate() - 7);
    }

    const drawId = lastDrawSat.toDateString();
    const seenDrawId = localStorage.getItem('seen_reveal_' + drawId);

    if (!seenDrawId) {
      startRevealSequence();
      localStorage.setItem('seen_reveal_' + drawId, 'true');
    }
  };

  const startRevealSequence = () => {
    if (!latestWin) return;
    setShowWinReveal(true);
    setRevealStep('searching');
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ballRadius = w < 768 ? 45 : 70;
    const colorStarters = [5, 15, 25, 35, 45, 55];
    const initialBalls: BallState[] = colorStarters.map((num, i) => {
      const winNum = latestWin!.ballNumber;
      const isWinner = (num >= Math.floor(winNum/10)*10 && num < Math.ceil(winNum/10)*10) || (winNum < 10 && num < 10);
      return {
        id: i,
        num: isWinner ? winNum : num,
        x: Math.random() * (w - 200) + 100,
        y: Math.random() * (h - 200) + 100,
        vx: (Math.random() - 0.5) * 20,
        vy: (Math.random() - 0.5) * 20,
        radius: ballRadius,
        isWinner
      };
    });
    revealRef.current = initialBalls;
    spotlightRef.current = { x: w / 2, y: h / 2 };
    
    let sequenceStartTime = Date.now();
    let searchTargetChangeTime = 0;
    let currentSearchTarget = { x: w / 2, y: h / 2 };

    const loop = () => {
      const now = Date.now();
      const elapsed = now - sequenceStartTime;
      const targetXCenter = w / 2;
      const targetYCenter = h * 0.4;
      const balls = revealRef.current;
      const winningBall = balls.find(b => b.isWinner)!;
      const isHoming = elapsed >= 6000;

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (isHoming && b.isWinner) continue;
        b.x += b.vx; b.y += b.vy;
        if (b.x < b.radius || b.x > w - b.radius) { b.vx *= -0.9; b.x = b.x < b.radius ? b.radius : w - b.radius; }
        if (b.y < b.radius || b.y > h - b.radius) { b.vy *= -0.9; b.y = b.y < b.radius ? b.radius : h - b.radius; }
      }

      if (elapsed < 3000) {
        if (now > searchTargetChangeTime) { currentSearchTarget = { x: Math.random() * w, y: Math.random() * h }; searchTargetChangeTime = now + 600; }
        spotlightRef.current.x += (currentSearchTarget.x - spotlightRef.current.x) * 0.08;
        spotlightRef.current.y += (currentSearchTarget.y - spotlightRef.current.y) * 0.08;
      } else if (elapsed < 6000) {
        if (revealStep !== 'tracking') setRevealStep('tracking');
        spotlightRef.current.x += (winningBall.x - spotlightRef.current.x) * 0.12;
        spotlightRef.current.y += (winningBall.y - spotlightRef.current.y) * 0.12;
      } else {
        if (revealStep !== 'homing') setRevealStep('homing');
        winningBall.x += (targetXCenter - winningBall.x) * 0.15;
        winningBall.y += (targetYCenter - winningBall.y) * 0.15;
        spotlightRef.current.x += (winningBall.x - spotlightRef.current.x) * 0.25;
        if (Math.abs(winningBall.x - targetXCenter) < 2) {
          winningBall.x = targetXCenter; winningBall.y = targetYCenter;
          setRevealBalls([...balls]); setRevealStep('settled');
          cancelAnimationFrame(revealRequestRef.current!);
          return;
        }
      }
      setRevealBalls([...balls]); setSpotlightPos({ ...spotlightRef.current });
      revealRequestRef.current = requestAnimationFrame(loop);
    };
    revealRequestRef.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    const w = window.innerWidth, h = window.innerHeight;
    setSmallBalls([{ id: 1, x: w * 0.2, y: h * 0.2, vx: 0.8, vy: 0.6, radius: 40, num: 7 }, { id: 2, x: w * 0.8, y: h * 0.7, vx: -0.7, vy: 0.8, radius: 45, num: 24 }, { id: 3, x: w * 0.5, y: h * 0.4, vx: 0.5, vy: -0.9, radius: 35, num: 42 }]);
    const update = () => {
      setSmallBalls(prev => prev.map(b => {
        let nx = b.x + b.vx, ny = b.y + b.vy, vx = b.vx, vy = b.vy;
        if (nx - b.radius < 0 || nx + b.radius > window.innerWidth) vx *= -1;
        if (ny - b.radius < 0 || ny + b.radius > window.innerHeight) vy *= -1;
        return { ...b, x: nx, y: ny, vx, vy };
      }));
      requestRef.current = requestAnimationFrame(update);
    };
    requestRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(requestRef.current!);
  }, []);
useEffect(() => {
  const testSupabase = async () => {
    const { data, error } = await supabase
      .from("bonus_ball_data")
      .select("id")
      .limit(1);

    console.log("✅ Supabase test data:", data);
    console.log("❌ Supabase test error:", error);
  };

  testSupabase();
}, []);

  const sendPush = (title: string, body: string, target: string, type: 'blast' | 'reminder' | 'win') => {
    setIsTransmitting(true);
    setTimeout(() => {
      const newNotif: NotificationMessage = { id: Math.random().toString(36).substr(2, 9), title, body, timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), type, target, read: false };
      setNotifications(prev => [newNotif, ...prev]); setIsTransmitting(false); setBlastMessage('');
    }, 800);
  };

  // CORE ACTIONS
  const commitAssignment = () => {
    if (!isAdmin) return;
    const num = adminAction?.ballNum;
    if (!num || !assignmentName.trim()) return;
    setManagedBallData(prev => ({
      ...prev,
      [num]: {
        name: assignmentName.trim(),
        status: 'paid',
        paidUntil: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
        nextDue: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
      }
    }));
    sendPush("Ball Assigned", `${assignmentName} has been assigned Ball #${num}`, "admin", "reminder");
    setAdminAction(null);
    setAssignmentName('');
    setSelectedBallNum(null);
  };

  const commitPayment = () => {
    if (!isAdmin) return;
    const num = adminAction?.ballNum;
    const weeks = parseInt(paymentWeeks);
    if (!num || isNaN(weeks) || weeks < 1) return;

    setManagedBallData(prev => {
      const current = prev[num];
      if (!current) return prev;
      
      const currentDue = new Date(current.nextDue);
      const baseDate = isNaN(currentDue.getTime()) ? new Date() : currentDue;
      const nextDueDate = new Date(baseDate.getTime() + (weeks * 7 * 24 * 60 * 60 * 1000));
      
      return {
        ...prev,
        [num]: {
          ...current,
          status: 'paid',
          paidUntil: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
          nextDue: nextDueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
        }
      };
    });

    sendPush("Payment Logged", `Received payment for Ball #${num} (${weeks} week${weeks > 1 ? 's' : ''})`, "admin", "reminder");
    setAdminAction(null);
    setPaymentWeeks('1');
    setSelectedBallNum(null);
  };

  const commitResult = () => {
    if (!isAdmin) return;
    const num = parseInt(resultBallNum);
    if (isNaN(num) || num < 1 || num > 59) return alert("Invalid ball number.");

    const winnerData = managedBallData[num];
    const isPaid = winnerData && (winnerData.status === 'paid' || winnerData.status === 'lifetime');
    
    let winnerName = "ROLLOVER";
    let prize = 0;
    let charity = 0;
    let newRollover = 0;

    if (isPaid) {
      winnerName = winnerData!.name;
      prize = currentPot;
      newRollover = 0;
    } else {
      winnerName = winnerData ? `${winnerData.name} (UNPAID)` : "VACANT";
      charity = currentPot / 2;
      newRollover = currentPot / 2;
    }

    const newResult: DrawResult = {
      date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
      ballNumber: num,
      winner: winnerName,
      prizeAmount: prize,
      charityAmount: charity,
    };

    setPastResults(prev => [newResult, ...prev]);
    setTotalRollover(newRollover);
    sendPush("Draw Recorded", `Ball #${num} won. Winner: ${winnerName}`, "all", "win");
    setAdminAction(null);
    setResultBallNum('');
  };

  const handleUpdatePaymentInitiate = (ballNum: number) => {
    if (!isAdmin) return;
    setAdminAction({ type: 'payment', ballNum });
  };

  const handleRemoveBall = (num: number) => {
    if (!isAdmin) return;
    if (confirm(`Are you sure you want to remove the owner of Ball #${num}?`)) {
      setManagedBallData(prev => {
        const d = { ...prev };
        delete d[num];
        return d;
      });
    }
  };

  const hasUnread = notifications.some(n => !n.read);

  return (
    <div className="relative min-h-screen bg-[#020407] overflow-hidden flex flex-col font-display">
      {/* WIN REVEAL */}
      {showWinReveal && (
        <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center bg-black overflow-hidden">
          <div className={`absolute inset-0 pointer-events-none transition-opacity duration-1000 ${revealStep === 'settled' ? 'opacity-0' : 'opacity-100'}`} style={{ background: `radial-gradient(circle 280px at ${spotlightPos.x}px ${spotlightPos.y}px, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.1) 40%, transparent 100%)` }} />
          <div className="relative w-full h-full pointer-events-none">
            {revealBalls.map(ball => (
              <div key={ball.id} className={`absolute transition-all ${ball.isWinner && revealStep === 'settled' ? 'duration-1000' : 'duration-0'} ease-out`} style={{ left: ball.x, top: ball.y, transform: `translate(-50%, -50%) ${ball.isWinner && revealStep === 'settled' ? 'scale(2.5)' : 'scale(1)'}`, opacity: revealStep === 'settled' && !ball.isWinner ? 0 : 1, zIndex: ball.isWinner ? 10 : 1 }}>
                <LotteryBall number={ball.num} hideShadow={true} showNumber={ball.isWinner && revealStep === 'settled'} className={`w-28 h-28 md:w-40 md:h-40 ${ball.isWinner && revealStep === 'settled' ? 'animate-pulse-win' : ''}`} />
              </div>
            ))}
            <div className={`absolute bottom-[12vh] left-0 w-full text-center transition-all duration-1000 delay-500 pointer-events-auto z-[50] ${revealStep === 'settled' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-20'}`}>
               <p className="text-pink-500 font-black uppercase tracking-[0.5em] text-[10px] mb-6">Saturday Draw Revealed</p>
               <h2 className="text-6xl md:text-8xl font-black text-white tracking-tighter uppercase leading-none mb-2 drop-shadow-2xl">{latestWin?.winner}</h2>
               <p className="text-yellow-500 font-black text-4xl md:text-6xl tracking-tighter drop-shadow-xl">£{latestWin?.prizeAmount || latestWin?.charityAmount || 0}</p>
               <div className="mt-14"><button onClick={() => setShowWinReveal(false)} className="px-14 py-5 bg-white text-black font-black uppercase text-[10px] tracking-[0.2em] rounded-full hover:bg-pink-500 hover:text-white transition-all shadow-2xl active:scale-95">Open Dashboard</button></div>
            </div>
          </div>
          <style dangerouslySetInnerHTML={{ __html: `@keyframes pulseWin { 0%, 100% { filter: drop-shadow(0 0 40px rgba(255,255,255,0.2)); transform: scale(2.5); } 50% { filter: drop-shadow(0 0 90px rgba(255,255,255,0.5)); transform: scale(2.6); } } .animate-pulse-win { animation: pulseWin 3s ease-in-out infinite; }`}} />
        </div>
      )}

      {isLoggedIn ? (
        <>
          <header className="relative z-10 pt-10 px-6 text-center">
             <div className="flex items-center justify-between max-w-6xl mx-auto w-full absolute top-6 px-6">
                <button onClick={() => { setShowInbox(true); setNotifications(prev => prev.map(n => ({...n, read: true}))); }} className={`relative p-3 rounded-full border transition-all ${hasUnread ? 'bg-pink-500 border-pink-500 text-black shadow-lg animate-pulse' : 'bg-white/5 border-white/10 text-white/40 hover:text-white'}`}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                  {hasUnread && <span className="absolute -top-1 -right-1 w-3 h-3 bg-white rounded-full border-2 border-pink-500"></span>}
                </button>
                <div className="flex items-center gap-4">
                  <span className="text-[9px] font-black uppercase text-white/20 truncate max-w-[150px] hidden md:block">{userEmail}</span>
                  <button onClick={() => setIsLoggedIn(false)} className="px-4 py-2 rounded-full border border-white/10 bg-white/5 text-white/40 hover:text-white transition-all text-[10px] font-black uppercase tracking-widest">Sign Out</button>
                </div>
             </div>
             <div className="w-12 h-12 rounded-full bg-pink-500 mx-auto flex items-center justify-center text-black font-black text-[10px] mb-4 shadow-[0_0_20px_rgba(236,72,153,0.3)] mt-12 animate-pulse">DWA</div>
             <h2 className="text-3xl font-black text-white tracking-tighter uppercase leading-none">{activeTab}</h2>
             <p className="text-pink-400 text-[9px] font-black uppercase tracking-[0.3em] mt-2">In Memory of Emmie-Rose</p>
          </header>

          <main className="relative z-10 flex-1 overflow-y-auto p-6 pb-40">
            <div className="max-w-6xl mx-auto">
              {activeTab === 'home' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
                  <div className="bg-red-500/10 border border-red-500/20 rounded-[2rem] p-8 md:p-10 shadow-2xl">
                    <div className="flex items-start gap-6">
                      <div className="w-12 h-12 rounded-2xl bg-red-500 flex items-center justify-center flex-shrink-0 text-white shadow-lg"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg></div>
                      <div>
                        <h4 className="text-xl font-black text-white tracking-tighter uppercase mb-2">Important Notice</h4>
                        <p className="text-white/60 text-sm leading-relaxed max-w-xl">Unpaid winners forfeit 50% to charity and 50% to rollover. Please keep your entries current.</p>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-2 bg-white/[0.03] backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-10 shadow-2xl space-y-8">
                      <div><h3 className="text-4xl font-black text-white tracking-tighter mb-4">The Guidelines</h3><p className="text-white/60 text-sm leading-relaxed max-w-lg">Charity initiative for <strong>Daddys With Angels</strong>. £2 per ball, drawn every Saturday night using the National Lottery Bonus Ball.</p></div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        <div className="flex gap-4 p-5 bg-white/5 rounded-3xl border border-white/5">
                          <div className="w-10 h-10 rounded-xl bg-pink-500/20 flex items-center justify-center text-pink-500"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1" /></svg></div>
                          <div><p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">Weekly Entry</p><p className="text-white font-bold text-lg">£2.00</p></div>
                        </div>
                        <div className="flex gap-4 p-5 bg-white/5 rounded-3xl border border-white/5">
                          <div className="w-10 h-10 rounded-xl bg-pink-500/20 flex items-center justify-center text-pink-500"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14" /></svg></div>
                          <div><p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">Draw Night</p><p className="text-white font-bold text-lg">Saturday</p></div>
                        </div>
                      </div>
                    </div>
                    <div className="bg-pink-500 border border-pink-400 rounded-[2.5rem] p-10 flex flex-col justify-between text-black">
                      <div className="w-16 h-16 rounded-2xl bg-black/10 flex items-center justify-center mb-10"><svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636" /></svg></div>
                      <div><p className="text-[10px] font-black uppercase tracking-widest mb-1 opacity-60">Total Raised</p><h4 className="text-5xl font-black tracking-tighter leading-none mb-2">£{totalRaised}</h4><p className="text-xs font-bold leading-tight">Supporting bereaved parents across the UK.</p></div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'balls' && (
                <div className="animate-in fade-in zoom-in-95 duration-500 space-y-10">
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white/[0.03] border border-white/10 rounded-3xl p-8 flex items-center justify-between shadow-xl"><div><p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">Upcoming Draw</p><p className="text-2xl font-black text-white">{formattedDrawDate}</p></div><div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center text-white/20 font-black text-xs">Sat</div></div>
                    <div className="bg-white/[0.03] border border-white/10 rounded-3xl p-8 flex items-center justify-between shadow-xl"><div><p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">Active Prize Pot</p><p className="text-4xl font-black text-white tracking-tighter">£{currentPot}</p></div><div className="px-3 py-1 bg-pink-500 text-black text-[10px] font-black rounded-full uppercase">Live</div></div>
                  </div>
                  <div className="bg-black/40 backdrop-blur-md border border-white/5 rounded-[3rem] p-10 md:p-14 shadow-2xl">
                    <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-6">
                      {Array.from({ length: 59 }).map((_, i) => {
                        const num = i + 1; const owner = managedBallData[num];
                        return (
                          <div key={num} onClick={() => setSelectedBallNum(num)} className="group cursor-pointer transition-all flex flex-col items-center gap-2">
                            <LotteryBall number={num} className="w-full group-hover:scale-110 transition-transform" opacity={owner ? 1 : 0.1} />
                            <p className={`text-[8px] font-black uppercase truncate w-full text-center mt-1 transition-colors ${owner?.status === 'overdue' ? 'text-yellow-500' : owner ? 'text-white/40' : 'text-white/10'}`}>{owner ? owner.name : 'Open'}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'winners' && (
                <div className="animate-in fade-in slide-in-from-right-4 duration-500 max-w-4xl mx-auto space-y-8">
                   <div className="text-center mb-12">
                     <h3 className="text-5xl font-black text-white tracking-tighter mb-2">Hall of Fame</h3>
                     <p className="text-white/40 text-[10px] font-black uppercase tracking-widest">Celebrating our lucky champions</p>
                   </div>
                   <div className="space-y-4">
                      {pastResults.length === 0 ? (
                        <div className="text-center py-20 opacity-20"><p className="font-black uppercase tracking-widest">No results yet</p></div>
                      ) : pastResults.map((r, i) => (
                        <div key={i} className="bg-white/[0.03] backdrop-blur-xl border border-white/10 p-8 rounded-[2rem] flex items-center gap-10 hover:bg-white/5 transition-all group">
                          <LotteryBall number={r.ballNumber} className="w-20 h-20 group-hover:rotate-12 transition-transform" />
                          <div className="flex-1 flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div><p className="text-[10px] font-black uppercase text-pink-500 tracking-widest mb-1">{r.date}</p><h4 className="text-3xl font-black text-white tracking-tighter leading-none">{r.winner}</h4></div>
                            <div className="text-right"><p className="text-[10px] font-black uppercase text-white/30 mb-1">Awarded</p><p className="text-3xl font-black text-yellow-500 tracking-tighter">£{r.prizeAmount || r.charityAmount}</p></div>
                          </div>
                        </div>
                      ))}
                    </div>
                </div>
              )}

              {activeTab === 'admin' && isAdmin && (
                <div className="animate-in fade-in slide-in-from-bottom-8 duration-500 space-y-12">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-2 space-y-8">
                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-10 shadow-2xl">
                        <div className="flex items-center justify-between mb-8">
                          <h4 className="text-2xl font-black text-white uppercase tracking-tighter">Directory Control</h4>
                          <input type="text" placeholder="Search..." className="bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-xs text-white outline-none focus:border-pink-500" value={adminSearchTerm} onChange={(e) => setAdminSearchTerm(e.target.value)} />
                        </div>
                        <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                          {Array.from({ length: 59 }).map((_, i) => {
                            const num = i + 1;
                            const data = managedBallData[num];
                            if (adminSearchTerm && !num.toString().includes(adminSearchTerm) && !(data && data.name.toLowerCase().includes(adminSearchTerm.toLowerCase()))) return null;
                            return (
                              <div key={num} className="bg-white/[0.02] border border-white/5 p-4 rounded-2xl flex items-center justify-between hover:bg-white/[0.05] transition-all">
                                <div className="flex items-center gap-4">
                                  <LotteryBall number={num} className="w-10 h-10" opacity={data ? 1 : 0.2} />
                                  <div>
                                    <p className="text-sm font-black text-white leading-none">{data ? data.name : `Vacant Ball #${num}`}</p>
                                    <p className="text-[9px] font-bold uppercase mt-1 text-white/30">{data ? (data.status === 'lifetime' ? 'Lifetime' : `Due: ${data.nextDue}`) : 'Available'}</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  {data ? (
                                    <>
                                      <button onClick={() => handleUpdatePaymentInitiate(num)} className={`px-3 py-1.5 text-[9px] font-black uppercase rounded-lg bg-pink-500 text-black hover:bg-pink-400 transition-all ${data.status === 'lifetime' ? 'hidden' : ''}`}>Record Payment</button>
                                      <button onClick={() => handleRemoveBall(num)} className="p-2 bg-white/5 text-white/30 hover:text-white rounded-lg"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
                                    </>
                                  ) : (
                                    <button onClick={() => setAdminAction({type: 'assign', ballNum: num})} className="px-3 py-1.5 bg-white/5 text-white/40 text-[9px] font-black uppercase rounded-lg hover:bg-white/10 transition-all">Assign Member</button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-10 shadow-2xl">
                        <h4 className="text-2xl font-black text-white uppercase tracking-tighter mb-8">Quick Actions</h4>
                        <div className="grid grid-cols-2 gap-4">
                          <button onClick={() => setAdminAction({type: 'result'})} className="flex flex-col items-center justify-center p-8 bg-white/5 border border-white/5 rounded-3xl hover:bg-white/10 transition-all gap-3">
                             <svg className="w-8 h-8 text-pink-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" /></svg>
                             <span className="text-[10px] font-black uppercase text-white/40 tracking-widest text-center">Add Result</span>
                          </button>
                          <button onClick={() => { if(confirm("Reset pot?")) setTotalRollover(0); }} className="flex flex-col items-center justify-center p-8 bg-white/5 border border-white/5 rounded-3xl hover:bg-white/10 transition-all gap-3">
                             <svg className="w-8 h-8 text-pink-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9" /></svg>
                             <span className="text-[10px] font-black uppercase text-white/40 tracking-widest text-center">Reset Pot</span>
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-8">
                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-10 shadow-2xl">
                        <h4 className="text-2xl font-black text-white uppercase tracking-tighter flex items-center gap-3 mb-8">Broadcaster</h4>
                        <div className="space-y-6">
                          <div><label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-3 block">Target</label><div className="flex gap-2">{(['all', 'unpaid'] as const).map(t => (
                                <button key={t} onClick={() => setBlastTarget(t)} className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg border transition-all ${blastTarget === t ? 'bg-pink-500 border-pink-500 text-black shadow-lg' : 'bg-white/5 border-white/10 text-white/40'}`}>{t}</button>
                              ))}</div></div>
                          <div><label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-3 block">Payload</label><textarea value={blastMessage} onChange={(e) => setBlastMessage(e.target.value)} rows={5} placeholder="Message text..." className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-4 text-white text-sm outline-none focus:border-pink-500 transition-all resize-none" /></div>
                          <button disabled={isTransmitting || !blastMessage} onClick={() => sendPush("Announcement", blastMessage, blastTarget, 'blast')} className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-widest rounded-2xl hover:bg-pink-400 transition-all disabled:opacity-30 shadow-xl shadow-pink-500/10">{isTransmitting ? 'Transmitting...' : 'Send Broadcast'}</button>
                        </div>
                      </div>
                      <div className="bg-gradient-to-br from-pink-500 to-pink-600 rounded-[2.5rem] p-10 text-black shadow-2xl">
                         <div className="flex justify-between items-start mb-10"><div><p className="text-[10px] font-black uppercase tracking-widest opacity-60">Revenue</p><h4 className="text-4xl font-black tracking-tighter leading-none">{paidCount > 0 ? 'Active' : 'Growth'}</h4></div><div className="w-10 h-10 rounded-full bg-black/10 flex items-center justify-center"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg></div></div>
                         <div className="space-y-4">
                           <div className="flex justify-between text-xs font-bold border-b border-black/10 pb-2"><span>Paid Members</span><span>{paidCount}/59</span></div>
                           <div className="flex justify-between text-xs font-bold border-b border-black/10 pb-2"><span>Total Raised</span><span>£{totalRaised}</span></div>
                           <div className="flex justify-between text-xs font-bold"><span>Prize Pot</span><span>£{currentPot}</span></div>
                         </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </main>

          {/* NAV BAR */}
          <nav className="fixed bottom-0 left-0 w-full bg-[#020407]/90 backdrop-blur-3xl border-t border-white/10 pb-safe z-50">
            <div className="max-w-2xl mx-auto flex items-center justify-between px-8 h-28">
              {(['home', 'balls', 'winners', 'admin'] as Tab[]).map(t => {
                if (t === 'admin' && !isAdmin) return null;
                return (
                  <button key={t} onClick={() => setActiveTab(t)} className={`flex flex-col items-center gap-2 transition-all group ${activeTab === t ? 'scale-110' : 'opacity-40 hover:opacity-100'}`}>
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all ${activeTab === t ? 'bg-pink-500 text-black shadow-[0_0_25px_rgba(236,72,153,0.3)]' : 'bg-white/5 text-white'}`}>
                      {t === 'home' && <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3" /></svg>}
                      {t === 'balls' && <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 6h16M4 12h16m-7 6h7" /></svg>}
                      {t === 'winners' && <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 3v4M3 5h4M6 17v4m-2-2h4" /></svg>}
                      {t === 'admin' && <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4" /></svg>}
                    </div>
                    <span className="text-[8px] font-black uppercase tracking-widest text-white/30 group-hover:text-white transition-colors">{t}</span>
                  </button>
                )
              })}
            </div>
          </nav>
        </>
      ) : (
        /* Login / Register */
        <main className="relative z-10 flex-1 flex flex-col items-center justify-center p-6">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full pointer-events-none opacity-20 overflow-hidden">
            {smallBalls.map(ball => (
              <div key={ball.id} className="absolute" style={{ left: ball.x, top: ball.y, width: ball.radius*2, height: ball.radius*2, transform: 'translate(-50%, -50%)' }}><LotteryBall number={ball.num} hideShadow={true} className="w-full h-full" opacity={0.3} blur="1px" /></div>
            ))}
          </div>
          <div className="relative z-10 text-center mb-12">
            <div className="w-16 h-16 rounded-full bg-pink-500 mx-auto flex items-center justify-center text-black font-black text-sm mb-6 shadow-2xl animate-bounce">DWA</div>
            <h1 className="text-7xl font-black text-white tracking-tighter uppercase leading-none">Bonus<br/><span className="text-pink-500">Ball</span></h1>
            <p className="text-[10px] font-black uppercase tracking-[0.5em] text-white/20 mt-4">In Memory of Emmie-Rose</p>
          </div>
          <div className="w-full max-w-md bg-white/[0.03] backdrop-blur-3xl border border-white/10 p-10 rounded-[3rem] shadow-2xl relative z-10 animate-in fade-in slide-in-from-bottom-10 duration-1000">
            {isRegistering ? (
              <form onSubmit={handleRegister} className="space-y-6">
                <div className="space-y-2"><label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">Full Name</label><input name="name" required type="text" className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all" /></div>
                <div className="space-y-2"><label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">Email Address</label><input name="email" required type="email" className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all" /></div>
                <div className="space-y-2"><label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">Secure Access Key</label><input name="password" required type="password" placeholder="••••••••" className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all" /></div>
                <button type="submit" className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-[0.3em] rounded-2xl hover:bg-pink-400 transition-all shadow-xl active:scale-95">Create Account</button>
                <button type="button" onClick={() => setIsRegistering(false)} className="w-full text-[10px] font-black uppercase tracking-widest text-white/30 hover:text-white transition-all">Already have an account? Sign In</button>
              </form>
            ) : (
              <form onSubmit={handleLogin} className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">Secure Email</label>
                  <input name="email" required type="email" defaultValue={ADMIN_EMAIL} className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">Access Key</label>
                  <input name="password" required type="password" defaultValue="••••••••" className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all" />
                </div>
                <div className="text-center space-y-2">
                  <button type="submit" className="w-full py-5 bg-white text-black font-black uppercase text-xs tracking-[0.3em] rounded-2xl hover:bg-pink-500 hover:text-white transition-all shadow-xl active:scale-95">Enter Platform</button>
                  <div className="pt-2">
                    <p className="text-[9px] font-bold text-white/10 uppercase tracking-widest mb-2">Permission Testing</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => { setUserEmail(ADMIN_EMAIL); setIsLoggedIn(true); }} className="flex-1 py-2 bg-white/5 border border-white/10 rounded-xl text-[8px] font-black uppercase tracking-widest text-white/30 hover:text-pink-500 transition-all">Carl (Admin)</button>
                      <button type="button" onClick={() => { setUserEmail(TEST_EMAIL); setIsLoggedIn(true); }} className="flex-1 py-2 bg-white/5 border border-white/10 rounded-xl text-[8px] font-black uppercase tracking-widest text-white/30 hover:text-pink-500 transition-all">Test User</button>
                    </div>
                  </div>
                </div>
                <button type="button" onClick={() => setIsRegistering(true)} className="w-full text-[10px] font-black uppercase tracking-widest text-white/30 hover:text-white transition-all">Don't have an account? Register</button>
              </form>
            )}
          </div>
        </main>
      )}

      {/* ADMIN ACTION MODAL */}
      {adminAction && isAdmin && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center p-6 animate-in fade-in duration-300">
           <div className="absolute inset-0 bg-black/90 backdrop-blur-2xl" onClick={() => setAdminAction(null)}></div>
           <div className="relative w-full max-w-lg bg-[#020407] border border-white/10 rounded-[3rem] p-12 shadow-2xl">
              <button onClick={() => setAdminAction(null)} className="absolute top-8 right-8 text-white/20 hover:text-white transition-all"><svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg></button>
              
              {adminAction.type === 'assign' && (
                <div className="text-center space-y-8">
                  <LotteryBall number={adminAction.ballNum!} className="w-32 h-32 mx-auto" />
                  <div><h3 className="text-4xl font-black text-white uppercase tracking-tighter mb-2">Assign Ball #{adminAction.ballNum}</h3><p className="text-white/30 text-xs font-black uppercase tracking-widest">Register a new member</p></div>
                  <div className="space-y-4">
                    <input autoFocus value={assignmentName} onChange={(e) => setAssignmentName(e.target.value)} type="text" placeholder="Member Name..." className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500" />
                    <button onClick={commitAssignment} className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-widest rounded-2xl hover:bg-pink-400 transition-all">Confirm Assignment</button>
                  </div>
                </div>
              )}

              {adminAction.type === 'payment' && (
                <div className="text-center space-y-8">
                  <LotteryBall number={adminAction.ballNum!} className="w-32 h-32 mx-auto" />
                  <div><h3 className="text-4xl font-black text-white uppercase tracking-tighter mb-2">Record Payment</h3><p className="text-white/30 text-xs font-black uppercase tracking-widest">Ball #{adminAction.ballNum} - {managedBallData[adminAction.ballNum!]?.name}</p></div>
                  <div className="grid grid-cols-2 gap-4">
                    <button onClick={() => { setPaymentWeeks('1'); setTimeout(commitPayment, 0); }} className="p-6 bg-white/5 border border-white/10 rounded-2xl hover:bg-pink-500 hover:text-black transition-all">
                      <span className="block text-xl font-black">1 Week</span>
                      <span className="text-[10px] uppercase font-bold opacity-60">£2.00</span>
                    </button>
                    <div className="p-6 bg-white/5 border border-white/10 rounded-2xl flex flex-col gap-2">
                       <span className="text-[10px] uppercase font-black text-white/30">Custom</span>
                       <div className="flex items-center gap-2">
                         <input value={paymentWeeks} onChange={(e) => setPaymentWeeks(e.target.value)} type="number" min="1" className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-center text-white" />
                         <button onClick={commitPayment} className="bg-pink-500 text-black p-1 rounded-lg"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg></button>
                       </div>
                    </div>
                  </div>
                </div>
              )}

              {adminAction.type === 'result' && (
                <div className="text-center space-y-8">
                  <div className="w-20 h-20 rounded-2xl bg-pink-500/20 mx-auto flex items-center justify-center text-pink-500"><svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg></div>
                  <div><h3 className="text-4xl font-black text-white uppercase tracking-tighter mb-2">Draw Result</h3><p className="text-white/30 text-xs font-black uppercase tracking-widest">Winning Bonus Ball</p></div>
                  <div className="space-y-4">
                    <input autoFocus value={resultBallNum} onChange={(e) => setResultBallNum(e.target.value)} type="number" placeholder="Winner # (1-59)" className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500" />
                    <button onClick={commitResult} className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-widest rounded-2xl hover:bg-pink-400 transition-all">Post Result</button>
                  </div>
                </div>
              )}
           </div>
        </div>
      )}

      {/* DETAIL MODAL */}
      {selectedBallNum && !adminAction && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-black/90 backdrop-blur-2xl" onClick={() => setSelectedBallNum(null)}></div>
          <div className="relative w-full max-w-lg bg-[#020407] border border-white/10 rounded-[3rem] p-12 shadow-2xl text-center">
            <button onClick={() => setSelectedBallNum(null)} className="absolute top-8 right-8 text-white/20 hover:text-white transition-all"><svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg></button>
            <LotteryBall number={selectedBallNum} className="w-56 h-56 mx-auto mb-10" />
            <h3 className="text-5xl font-black text-white uppercase tracking-tighter mb-4 leading-none">{managedBallData[selectedBallNum] ? managedBallData[selectedBallNum].name : 'Available'}</h3>
            {managedBallData[selectedBallNum] ? (
               <div className="space-y-4">
                 <div className="flex justify-between p-6 bg-white/5 rounded-3xl border border-white/5 items-center">
                   <div className="text-left"><span className="text-[10px] font-black uppercase text-white/30 tracking-widest block mb-1">Status</span><span className={`text-sm font-bold uppercase tracking-widest ${managedBallData[selectedBallNum].status === 'paid' ? 'text-green-500' : 'text-yellow-500'}`}>{managedBallData[selectedBallNum].status}</span></div>
                   <div className="text-right"><span className="text-[10px] font-black uppercase text-white/30 tracking-widest block mb-1">Due Date</span><span className="text-sm font-bold text-white">{managedBallData[selectedBallNum].nextDue}</span></div>
                 </div>
                 {isAdmin && (
                    <button onClick={() => handleUpdatePaymentInitiate(selectedBallNum)} className="w-full py-5 bg-white/5 border border-white/10 rounded-2xl text-[10px] font-black uppercase tracking-widest text-white hover:bg-white/10 transition-all">Record Payment</button>
                 )}
               </div>
            ) : (
              <div className="space-y-6">
                <p className="text-white/40 text-sm">Ball #{selectedBallNum} is vacant.</p>
                {isAdmin && (
                  <button onClick={() => setAdminAction({type: 'assign', ballNum: selectedBallNum})} className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-widest rounded-2xl hover:bg-pink-400 transition-all">Assign Member</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* INBOX */}
      {showInbox && (
        <div className="fixed inset-0 z-[200] flex flex-col animate-in slide-in-from-top duration-500 bg-[#020407]">
          <header className="p-8 flex items-center justify-between border-b border-white/10">
            <h3 className="text-4xl font-black text-white tracking-tighter uppercase">Notifications</h3>
            <button onClick={() => setShowInbox(false)} className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center text-white/40 hover:text-white transition-all"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg></button>
          </header>
          <div className="flex-1 overflow-y-auto p-8 space-y-6 max-w-4xl mx-auto w-full">
            {notifications.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-20"><p className="font-black uppercase tracking-widest">No Alerts</p></div>
            ) : notifications.map(n => (
              <div key={n.id} className="bg-white/[0.03] border border-white/5 p-8 rounded-[2rem] flex gap-6 items-start">
                 <div className={`w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 ${n.type === 'blast' ? 'bg-pink-500 text-black' : 'bg-white/5 text-white/40'}`}>
                   {n.type === 'blast' ? <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M11 5.882V19.24" /></svg> : <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 17h5" /></svg>}
                 </div>
                 <div className="flex-1">
                    <div className="flex justify-between items-center mb-2"><h5 className="font-black text-white uppercase tracking-tighter text-xl">{n.title}</h5><span className="text-[10px] font-bold text-white/20">{n.timestamp}</span></div>
                    <p className="text-white/60 leading-relaxed text-sm">{n.body}</p>
                 </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
