// gitupdate 
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

// Auth flow modes
type AuthMode = "login" | "register" | "forgot" | "reset";

const ADMIN_EMAIL = 'Carlwhalliday@icloud.com';
const TEST_EMAIL = 'test@user.com';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const isLoggedIn = !!sessionEmail;
  const [userEmail, setUserEmail] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [isRecoveryMode, setIsRecoveryMode] = useState(false); // recovery link detection
  const [newPassword, setNewPassword] = useState(''); // recovery password input
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);
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
  const [balls, setBalls] = useState<any[]>([]);
  const [bonusBallRowId, setBonusBallRowId] = useState<string | null>(null);
  const [showNotCoveredOnly, setShowNotCoveredOnly] = useState(false);
  const [applyToAllOwner, setApplyToAllOwner] = useState(false);
  const [rolloverAmount, setRolloverAmount] = useState(0);
  const [selectedResultBall, setSelectedResultBall] = useState<number | null>(null);
  const [winnerRows, setWinnerRows] = useState<any[]>([]);
  const [drawDate, setDrawDate] = useState<string | null>(null);
  const [drawTimestamp, setDrawTimestamp] = useState<string | null>(null);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [adminSearchTerm, setAdminSearchTerm] = useState('');
  const [loginEmail, setLoginEmail] = useState("");
  const requestRef = useRef<number>(null);

  const [managedBallData, setManagedBallData] = useState<Record<number, BallOwnerDetails>>({});
  const [pastResults, setPastResults] = useState<DrawResult[]>([]);
  const [totalRollover, setTotalRollover] = useState(0);

  // DYNAMIC CALCULATIONS
const isAdmin = useMemo(() => {
  if (!sessionEmail) return false;
  return sessionEmail.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}, [sessionEmail]);

  const paidCount = useMemo(() => Object.values(managedBallData).filter(b => b.status === 'paid' || b.status === 'lifetime').length, [managedBallData]);
  const totalRaised = useMemo(() => pastResults.reduce((acc, curr) => acc + curr.charityAmount, 0), [pastResults]);

  const upcomingDrawDate = useMemo(() => drawDate ? new Date(drawDate) : null, [drawDate]);
  const upcomingDrawDateTime = useMemo(() => {
    if (drawTimestamp) return new Date(drawTimestamp);
    if (drawDate) {
      const d = new Date(drawDate);
      d.setHours(20, 0, 0, 0);
      return d;
    }
    return null;
  }, [drawDate, drawTimestamp]);
  const currentPot = useMemo(() => {
    const coveredCount = balls.reduce((acc, ball) => {
      if (!ball.paidUntil) return acc;
      const paidUntilDate = new Date(ball.paidUntil);
      const normalizedPaidUntil = new Date(paidUntilDate);
      normalizedPaidUntil.setHours(20, 0, 0, 0);
      if (!upcomingDrawDateTime) return acc;
      return normalizedPaidUntil >= upcomingDrawDateTime ? acc + 1 : acc;
    }, 0);
    return totalRollover + coveredCount * 2;
  }, [balls, upcomingDrawDateTime, totalRollover]);

  const formattedDrawDate = useMemo(() => {
    if (!drawDate) return '';
    return new Date(drawDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }, [drawDate]);
  const baselineSaturday = useMemo(() => {
    const today = new Date();
    const sat = new Date(today);
    sat.setHours(0, 0, 0, 0);
    sat.setDate(today.getDate() - ((today.getDay() + 1) % 7));
    return sat;
  }, []);
  const drawDateTime = useMemo(() => {
    const today = new Date();
    const sat = new Date(today);
    sat.setHours(20, 0, 0, 0);
    sat.setDate(today.getDate() - ((today.getDay() + 1) % 7));
    return sat;
  }, []);
  const totalBank = useMemo(() => {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    return balls.reduce((sum, ball) => {
      if (!ball.paidUntil) return sum;
      const paidUntilDate = new Date(ball.paidUntil);
      if (paidUntilDate < drawDateTime) return sum;
      const weeksPaid = Math.floor((paidUntilDate.getTime() - drawDateTime.getTime()) / weekMs) + 1;
      const ballAmount = weeksPaid * 2;
      return sum + ballAmount;
    }, 0);
  }, [balls, drawDateTime]);

  const latestWin = pastResults.length > 0 ? pastResults[0] : null;
  const handleRecordResult = () => {
    if (!selectedResultBall) return;
    const ball = balls.find(b => b.number === selectedResultBall);
    const hasOwner = !!ball?.owner;
    if (hasOwner) {
      setTotalRollover(0);
      setRolloverAmount(0);
    } else {
      const newRollover = currentPot / 2;
      setTotalRollover(newRollover);
      setRolloverAmount(newRollover);
    }
    const drawDate = upcomingDrawDateTime.toISOString().split('T')[0];
    const drawTimestamp = upcomingDrawDateTime.toISOString();
    const amountWon = hasOwner ? currentPot : currentPot / 2;
    const rolloverPersist = hasOwner ? 0 : currentPot / 2;
    const winnerName = ball?.owner ?? null;
    supabase
      .from("bonus_ball_winners")
      .insert([
        {
          draw_date: drawDate,
          draw_timestamp: drawTimestamp,
          winning_number: selectedResultBall,
          winner_name: winnerName,
          winner_user_id: null,
          amount_won: amountWon,
          rollover_amount: rolloverPersist,
        },
      ])
      .then(({ error }) => {
        if (error) {
          console.error("❌ Failed to record winner", error);
        } else {
          console.log("✅ Winner recorded");
        }
      });
  };

  // HANDLERS
  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();

  const formData = new FormData(e.currentTarget);
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    alert(error.message);
    return;
  }

  const signedInEmail = data.user?.email ?? email;
  setUserEmail(signedInEmail);

  if (latestWin) checkReveal();
};


  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();

  const formData = new FormData(e.currentTarget);
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    alert(error.message);
    return;
  }

  // If email confirmations are ON, session may be null until confirmed.
  const signedUpEmail = data.user?.email ?? email;
  setUserEmail(signedUpEmail);

  // Try to immediately log in if a session exists (confirmations OFF).
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) {
    sendPush("Welcome", "Your account has been successfully created.", "admin", "reminder");
  } else {
    alert("Account created. Please check your email to confirm, then log in.");
  }
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
  // This completes password reset / magic link flows
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) {
      console.error("Auth session error:", error.message);
    }
    const recoveryFlag = Boolean((data.session?.user as any)?.recovery_sent_at);
    setIsRecoveryMode(recoveryFlag);
    if (recoveryFlag) setAuthMode("reset");
    setSessionEmail(data.session?.user.email ?? null);
  });

  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    console.log("Auth event:", event);
    if (event === "PASSWORD_RECOVERY") {
      setAuthMode("reset");
    }
    if (event === "INITIAL_SESSION" && session) {
      loadBallsFromDb();
    }

    const recoveryFlag = Boolean((session?.user as any)?.recovery_sent_at);
    setIsRecoveryMode(recoveryFlag);
    setSessionEmail(session?.user.email ?? null);
  });

  return () => sub.subscription.unsubscribe();
}, []);
useEffect(() => {
  supabase
    .from("bonus_ball_config")
    .select("current_draw_date, current_draw_timestamp")
    .single()
    .then(({ data, error }) => {
      if (error) {
        console.error("❌ Failed to load draw config", error);
        return;
      }
      setDrawDate(data.current_draw_date ?? null);
      setDrawTimestamp(data.current_draw_timestamp ?? null);
    });
}, []);
useEffect(() => {
  supabase
    .from("bonus_ball_winners")
    .select("*")
    .order("draw_date", { ascending: false })
    .then(({ data, error }) => {
      if (error) {
        console.error("❌ Failed to load winners", error);
        return;
      }
      setWinnerRows(data ?? []);
    });
}, []);

const handleForgotPassword = async (e: React.FormEvent) => {
  e.preventDefault();

  const form = e.target as HTMLFormElement;
  const email = (form.elements.namedItem("email") as HTMLInputElement).value;

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });

  if (error) {
    alert(error.message);
    return;
  }

  alert("Password reset email sent.");
  setAuthMode("login");
};

const handleResetPassword = async (e: React.FormEvent) => {
  e.preventDefault();

  const form = e.target as HTMLFormElement;
  const password = (form.elements.namedItem("password") as HTMLInputElement).value;

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    alert(error.message);
    return;
  }

  alert("Password updated. You can now log in.");
  setAuthMode("login");
};

const loadBallsFromDb = async () => {
  console.log("🔥 Loading bonus_ball_data from Supabase");

  const { data, error } = await supabase
    .from("bonus_ball_data")
    .select("id, state")
    .single();

  if (error) {
    console.error("❌ Failed to load bonus_ball_data", error);
    return;
  }

  if (!data?.state?.balls) {
    console.warn("⚠️ bonus_ball_data has no balls array");
    return;
  }

  console.log("✅ Loaded balls:", data.state.balls);
  setBonusBallRowId(data.id ?? null);
  setBalls(data.state.balls);
};

// Recovery modal password update (blocking)
const handleRecoveryPasswordSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!newPassword.trim()) return;
  setIsUpdatingPassword(true);
  const { error } = await supabase.auth.updateUser({ password: newPassword.trim() });
  setIsUpdatingPassword(false);
  if (error) {
    alert(error.message);
    return;
  }
  setIsRecoveryMode(false);
  setNewPassword('');
  alert("Password updated.");
};


  const sendPush = (title: string, body: string, target: string, type: 'blast' | 'reminder' | 'win') => {
    setIsTransmitting(true);
    setTimeout(() => {
      const newNotif: NotificationMessage = { id: Math.random().toString(36).substr(2, 9), title, body, timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), type, target, read: false };
      setNotifications(prev => [newNotif, ...prev]); setIsTransmitting(false); setBlastMessage('');
    }, 800);
  };

  // CORE ACTIONS
  const commitAssignment = () => {
    console.log("🧪 assign start", { selectedBall: adminAction?.ballNum, bonusBallRowId });
    if (!isAdmin) {
      console.log("🧪 assign aborted", { reason: "guard", selectedBall: adminAction?.ballNum, bonusBallRowId });
      return;
    }
    const num = adminAction?.ballNum;
    if (!num || !assignmentName.trim()) {
      console.log("🧪 assign aborted", { reason: "guard", selectedBall: adminAction?.ballNum, bonusBallRowId });
      return;
    }
    console.log("🧪 assign persisting");
    const updatedBalls = balls.map(b => b.number === num ? { ...b, owner: assignmentName.trim() } : b);
    setManagedBallData(prev => ({
      ...prev,
      [num]: {
        name: assignmentName.trim(),
        status: 'paid',
        paidUntil: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
        nextDue: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
      }
    }));
    setBalls(updatedBalls);
    console.log("✅ assign persisted");
    sendPush("Ball Assigned", `${assignmentName} has been assigned Ball #${num}`, "admin", "reminder");
    setAdminAction(null);
    setAssignmentName('');
    setSelectedBallNum(null);
  };

  const commitPayment = async () => {
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

    const selectedBall = balls.find(b => b.number === num);
    const targetOwner = applyToAllOwner ? selectedBall?.owner : null;
    const affectedNumbers = applyToAllOwner && targetOwner
      ? balls.filter(b => b.owner === targetOwner).map(b => b.number)
      : [num];

    const updatedBalls = balls.map(ball => {
      if (!affectedNumbers.includes(ball.number)) return ball;
      const today = new Date();
      const saturday = new Date(today);
      saturday.setHours(0, 0, 0, 0);
      saturday.setDate(today.getDate() - ((today.getDay() + 1) % 7));

      const existingPaidUntil = ball.paidUntil ? new Date(ball.paidUntil) : null;
      const startDate = existingPaidUntil && existingPaidUntil > saturday ? existingPaidUntil : saturday;
      const newPaidUntilDate = new Date(startDate);
      newPaidUntilDate.setDate(newPaidUntilDate.getDate() + (weeks * 7));
      const formattedPaidUntil = newPaidUntilDate.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit' }).replace(',', '');
      return { ...ball, paidUntil: formattedPaidUntil };
    });

    if (!bonusBallRowId) return;

    console.log(`💾 Persisting payment for bonus_ball_data row ${bonusBallRowId}`);
    console.log(`💾 Persisting payment for ball ${num}`);
    const { error: updateErr } = await supabase
      .from("bonus_ball_data")
      .update({ state: { balls: updatedBalls } })
      .eq("id", bonusBallRowId)
      .select()
      .single();
    if (updateErr) {
      console.error("❌ Failed to persist payment", updateErr);
    } else {
      setBalls(updatedBalls);
      console.log("✅ Payment persisted");
    }

    sendPush("Payment Logged", `Received payment for Ball #${num} (${weeks} week${weeks > 1 ? 's' : ''})`, "admin", "reminder");
    setAdminAction(null);
    setPaymentWeeks('1');
    setApplyToAllOwner(false);
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
  const selectedBall = balls.find(b => b.number === selectedBallNum);

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
          {/* STRUCTURE FIX: Logged-in shell */}
          <header className="relative z-10 pt-10 px-6 text-center">
            <div className="flex items-center justify-between max-w-6xl mx-auto w-full absolute top-6 px-6">
              <button onClick={() => { setShowInbox(true); setNotifications(prev => prev.map(n => ({ ...n, read: true }))); }} className={`relative p-3 rounded-full border transition-all ${hasUnread ? 'bg-pink-500 border-pink-500 text-black shadow-lg animate-pulse' : 'bg-white/5 border-white/10 text-white/40 hover:text-white'}`}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                {hasUnread && <span className="absolute -top-1 -right-1 w-3 h-3 bg-white rounded-full border-2 border-pink-500"></span>}
              </button>
              <div className="flex items-center gap-4">
                <span className="text-[9px] font-black uppercase text-white/20 truncate max-w-[150px] hidden md:block">{userEmail}</span>
                <button onClick={async () => {
                  await supabase.auth.signOut();
                  setSessionEmail(null);
                  setUserEmail("");
                }} className="px-4 py-2 rounded-full border border-white/10 bg-white/5 text-white/40 hover:text-white transition-all text-[10px] font-black uppercase tracking-widest">Sign Out</button>
              </div>
            </div>
            <div className="w-12 h-12 rounded-full bg-pink-500 mx-auto flex items-center justify-center text-black font-black text-[10px] mb-4 shadow-[0_0_20px_rgba(236,72,153,0.3)] mt-12 animate-pulse">DWA</div>
            <h2 className="text-3xl font-black text-white tracking-tighter uppercase leading-none">{activeTab}</h2>
            <p className="text-pink-400 text-[9px] font-black uppercase tracking-[0.3em] mt-2">In Memory of Emmie-Rose</p>
            {sessionEmail ? (
              <p className="text-white/40 text-[10px] font-bold mt-2">Signed in as {sessionEmail}</p>
            ) : (
              <p className="text-white/40 text-[10px] font-bold mt-2">Not signed in</p>
            )}
            {sessionEmail ? (
              <button
                onClick={async () => {
                  const perm = await Notification.requestPermission();
                  if (perm !== "granted") {
                    alert("Notifications permission not granted.");
                    return;
                  }

                  const reg = await navigator.serviceWorker.ready;
                  const sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    // VAPID key comes next step
                    applicationServerKey: "BF0JTRjgcFnKfEuf1fE2kGQVW46CHgNRWe_VI_92DMtGsoEpixnIcOUd8P0Fx_pXVvyEhahuueCMkM0gThg4aeM",
                  });

                  console.log("Push subscription:", JSON.stringify(sub));
                  const {
                    data: { user },
                    error: userErr,
                  } = await supabase.auth.getUser();

                  if (userErr || !user) {
                    alert("Not logged in.");
                    return;
                  }

                  const json = sub.toJSON();
                  const endpoint = json.endpoint;
                  const p256dh = json.keys?.p256dh;
                  const auth = json.keys?.auth;

                  if (!endpoint || !p256dh || !auth) {
                    alert("Subscription missing required fields.");
                    return;
                  }

                  const { error: upsertErr } = await supabase.from("push_subscriptions").upsert(
                    {
                      user_id: user.id,
                      endpoint,
                      p256dh,
                      auth,
                      created_at: new Date().toISOString(),
                    },
                    { onConflict: "endpoint" }
                  );

                  if (upsertErr) {
                    alert(upsertErr.message);
                    return;
                  }

                  alert("Subscribed and saved!");

                }}
                className="mt-3 px-4 py-2 rounded-full border border-white/10 bg-white/5 text-white/60 hover:text-white transition-all text-[10px] font-black uppercase tracking-widest"
              >
                Enable Notifications
              </button>
            ) : null}

            {sessionEmail ? (
              <button
                onClick={async () => {
                  const { data } = await supabase.auth.getUser();
                  const id = data.user?.id;

                  if (!id) {
                    alert("No user (not logged in)");
                    return;
                  }

                  await navigator.clipboard.writeText(id);
                  alert("Copied user id: " + id);
                }}
                className="mt-3 px-4 py-2 rounded-full border border-white/10 bg-white/5 text-white/60 hover:text-white transition-all text-[10px] font-black uppercase tracking-widest"
              >
                Copy User ID
              </button>
            ) : null}
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
                      {balls.map((ball) => {
                        const num = ball.number;
                        const ownerName = ball.owner;
                        return (
                          <div key={num} onClick={() => setSelectedBallNum(num)} className="group cursor-pointer transition-all flex flex-col items-center gap-2">
                            <LotteryBall number={num} className="w-full group-hover:scale-110 transition-transform" opacity={ownerName ? 1 : 0.1} />
                            <p className={`text-[8px] font-black uppercase truncate w-full text-center mt-1 transition-colors ${ownerName ? 'text-white/40' : 'text-white/10'}`}>{ownerName ?? 'Open'}</p>
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
                      {winnerRows.length === 0 ? (
                        <div className="text-center py-20 opacity-20"><p className="font-black uppercase tracking-widest">No results yet</p></div>
                      ) : winnerRows.map((r, i) => (
                        <div key={i} className="bg-white/[0.03] backdrop-blur-xl border border-white/10 p-8 rounded-[2rem] flex items-center gap-10 hover:bg-white/5 transition-all group">
                          <LotteryBall number={r.winning_number} className="w-20 h-20 group-hover:rotate-12 transition-transform" />
                          <div className="flex-1 flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div><p className="text-[10px] font-black uppercase text-pink-500 tracking-widest mb-1">{r.draw_date}</p><h4 className="text-3xl font-black text-white tracking-tighter leading-none">{r.winner_name ?? 'VACANT'}</h4></div>
                            <div className="text-right"><p className="text-[10px] font-black uppercase text-white/30 mb-1">Awarded</p><p className="text-3xl font-black text-yellow-500 tracking-tighter">£{r.amount_won}</p></div>
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
                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-white/40">
                              <input
                                type="checkbox"
                                className="accent-pink-500"
                                checked={showNotCoveredOnly}
                                onChange={(e) => setShowNotCoveredOnly(e.target.checked)}
                              />
                              Show not covered for next draw
                            </label>
                            <input type="text" placeholder="Search..." className="bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-xs text-white outline-none focus:border-pink-500" value={adminSearchTerm} onChange={(e) => setAdminSearchTerm(e.target.value)} />
                          </div>
                          <p className="text-[10px] font-black uppercase tracking-widest text-white/50 mt-4">Total paid (including advance): £{totalBank}</p>
                        </div>
                        <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                          {balls.map((ball) => {
                            const num = ball.number;
                            const ownerName = ball.owner;
                            const nextDueDate = ball.paidUntil
                              ? new Date(new Date(ball.paidUntil).getTime() + 7 * 24 * 60 * 60 * 1000)
                              : null;
                            const nextDueLabel = nextDueDate
                              ? nextDueDate.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).replace(',', '')
                              : 'N/A';
                            const notCovered = !ball.paidUntil || (upcomingDrawDate && new Date(ball.paidUntil) < new Date(upcomingDrawDate));
                            const matchesSearch =
                              !adminSearchTerm ||
                              num.toString().includes(adminSearchTerm) ||
                              (ownerName && ownerName.toLowerCase().includes(adminSearchTerm.toLowerCase()));
                            if (!matchesSearch) return null;
                            if (showNotCoveredOnly && !notCovered) return null;
                            return (
                              <div key={num} className="bg-white/[0.02] border border-white/5 p-4 rounded-2xl flex items-center justify-between hover:bg-white/[0.05] transition-all">
                                <div className="flex items-center gap-4">
                                  <LotteryBall number={num} className="w-10 h-10" opacity={ownerName ? 1 : 0.2} />
                                  <div>
                                    <p className="text-sm font-black text-white leading-none">{ownerName ?? `Vacant Ball #${num}`}</p>
                                    <p className="text-[9px] font-bold uppercase mt-1 text-white/30">{ownerName ? `Due: ${nextDueLabel}` : 'Available'}</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  {ownerName ? (
                                    <>
                                      <button onClick={() => handleUpdatePaymentInitiate(num)} className="px-3 py-1.5 text-[9px] font-black uppercase rounded-lg bg-pink-500 text-black hover:bg-pink-400 transition-all">Record Payment</button>
                                      <button onClick={() => handleRemoveBall(num)} className="p-2 bg-white/5 text-white/30 hover:text-white rounded-lg"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
                                    </>
                                  ) : (
                                    <button onClick={() => setAdminAction({ type: 'assign', ballNum: num })} className="px-3 py-1.5 bg-white/5 text-white/40 text-[9px] font-black uppercase rounded-lg hover:bg-white/10 transition-all">Assign Member</button>
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
                          <button onClick={() => setAdminAction({ type: 'result' })} className="flex flex-col items-center justify-center p-8 bg-white/5 border border-white/5 rounded-3xl hover:bg-white/10 transition-all gap-3">
                            <svg className="w-8 h-8 text-pink-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" /></svg>
                            <span className="text-[10px] font-black uppercase text-white/40 tracking-widest text-center">Add Result</span>
                          </button>
                          <button onClick={() => { if (confirm("Reset pot?")) setTotalRollover(0); }} className="flex flex-col items-center justify-center p-8 bg-white/5 border border-white/5 rounded-3xl hover:bg-white/10 transition-all gap-3">
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
                          <button
                            onClick={async () => {
                              const res = await fetch("/.netlify/functions/push-broadcast", {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ title: "Test Push", body: "Hello from Netlify Function ✅" }),
                              });

                              const text = await res.text();
                              if (!res.ok) {
                                alert(text);
                                return;
                              }
                              alert(text);
                            }}
                            className="w-full py-4 bg-white/10 text-white font-black uppercase text-xs tracking-widest rounded-2xl hover:bg-white/20 transition-all"
                          >
                            Send Test Push (Real)
                          </button>

                        </div>
                      </div>
                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-10 shadow-2xl">
                        <h4 className="text-2xl font-black text-white uppercase tracking-tighter mb-6">Record Result</h4>
                        <div className="space-y-4">
                          <select
                            className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm"
                            value={selectedResultBall ?? ''}
                            onChange={(e) => setSelectedResultBall(e.target.value ? Number(e.target.value) : null)}
                          >
                            <option value="">Select ball</option>
                            {balls.map(b => (
                              <option key={b.number} value={b.number}>{b.number} {b.owner ? `- ${b.owner}` : '- Vacant'}</option>
                            ))}
                          </select>
                          <button
                            onClick={handleRecordResult}
                            className="w-full py-4 bg-pink-500 text-black font-black uppercase text-xs tracking-widest rounded-xl"
                          >
                            Record Result
                          </button>
                          <p className="text-[10px] font-black uppercase tracking-widest text-white/50">Rollover: £{rolloverAmount}</p>
                        </div>
                      </div>
                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-10 shadow-2xl">
                        <h4 className="text-2xl font-black text-white uppercase tracking-tighter mb-6">Bank</h4>
                        <p className="text-sm font-black text-white/80">Total paid (including advance): £{totalBank}</p>
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
                );
              })}
            </div>
          </nav>

          {/* ADMIN ACTION MODAL */}
          {adminAction && isAdmin && (
            <div className="fixed inset-0 z-[500] flex items-center justify-center p-6 animate-in fade-in duration-300">
              <div
                className="absolute inset-0 bg-black/90 backdrop-blur-2xl"
                onClick={() => setAdminAction(null)}
              />
              <div className="relative w-full max-w-lg bg-[#020407] border border-white/10 rounded-[3rem] p-12 shadow-2xl">
                <button
                  onClick={() => setAdminAction(null)}
                  className="absolute top-8 right-8 text-white/20 hover:text-white"
                >
                  ✕
                </button>

                {adminAction.type === "assign" && (
                  <div className="space-y-6 text-center">
                    <LotteryBall number={adminAction.ballNum!} className="w-32 h-32 mx-auto" />
                    <input
                      autoFocus
                      value={assignmentName}
                      onChange={(e) => setAssignmentName(e.target.value)}
                      placeholder="Member name"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white"
                    />
                    <button
                      onClick={commitAssignment}
                      className="w-full py-4 bg-pink-500 text-black font-black rounded-xl"
                    >
                      Confirm Assignment
                    </button>
                  </div>
                )}
                {adminAction.type === "payment" && (
                  <div className="space-y-6 text-center">
                    <LotteryBall number={adminAction.ballNum!} className="w-32 h-32 mx-auto" />
                    <p className="text-white/70 text-sm">Record payment for Ball #{adminAction.ballNum}</p>
                    <div className="flex gap-3 justify-center">
                      <button
                        onClick={() => setPaymentWeeks('1')}
                        className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border ${paymentWeeks === '1' ? 'bg-pink-500 border-pink-500 text-black' : 'bg-white/5 border-white/10 text-white/60'}`}
                      >
                        1 week
                      </button>
                      <button
                        onClick={() => setPaymentWeeks('4')}
                        className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border ${paymentWeeks === '4' ? 'bg-pink-500 border-pink-500 text-black' : 'bg-white/5 border-white/10 text-white/60'}`}
                      >
                        4 weeks
                      </button>
                    </div>
                    <input
                      type="number"
                      min="1"
                      value={paymentWeeks}
                      onChange={(e) => setPaymentWeeks(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-center"
                      placeholder="Weeks to add"
                    />
                    <label className="flex items-center gap-2 justify-center text-[10px] font-black uppercase tracking-widest text-white/60">
                      <input
                        type="checkbox"
                        className="accent-pink-500"
                        checked={applyToAllOwner}
                        onChange={(e) => setApplyToAllOwner(e.target.checked)}
                      />
                      Apply to all numbers owned by this person
                    </label>
                    <button
                      onClick={commitPayment}
                      className="w-full py-4 bg-pink-500 text-black font-black rounded-xl"
                    >
                      Confirm Payment
                    </button>
                  </div>
                )}
                {adminAction.type === "result" && (
                  <div className="space-y-4 text-center">
                    <h4 className="text-xl font-black text-white uppercase">Record Draw Result</h4>
                    <p className="text-white/60 text-sm">
                      Winning Ball: {selectedResultBall ?? 'None selected'}
                    </p>
                    <p className="text-white/50 text-xs">
                      Status: {(() => {
                        const ball = balls.find(b => b.number === selectedResultBall);
                        return ball?.owner ? 'Assigned' : 'Unassigned';
                      })()}
                    </p>
                    <select
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm"
                      value={selectedResultBall ?? ''}
                      onChange={(e) => setSelectedResultBall(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">Select ball</option>
                      {balls.map(b => (
                        <option key={b.number} value={b.number}>{b.number} {b.owner ? `- ${b.owner}` : '- Vacant'}</option>
                      ))}
                    </select>
                    <div className="flex gap-3 justify-center">
                      <button
                        onClick={() => { handleRecordResult(); setAdminAction(null); }}
                        className="flex-1 py-3 bg-pink-500 text-black font-black uppercase text-xs rounded-xl"
                      >
                        Confirm Result
                      </button>
                      <button
                        onClick={() => setAdminAction(null)}
                        className="flex-1 py-3 bg-white/10 text-white font-black uppercase text-xs rounded-xl"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* DETAIL MODAL */}
          {selectedBallNum && !adminAction && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
              <div
                className="absolute inset-0 bg-black/90 backdrop-blur-2xl"
                onClick={() => setSelectedBallNum(null)}
              />
              <div className="relative w-full max-w-lg bg-[#020407] border border-white/10 rounded-[3rem] p-12 text-center">
              <button
                onClick={() => setSelectedBallNum(null)}
                className="absolute top-8 right-8 text-white/20 hover:text-white"
              >
                ✕
              </button>
              <LotteryBall number={selectedBallNum} className="w-56 h-56 mx-auto mb-8" />
              {selectedBall && (
                <div className="space-y-2 text-white">
                  <p className="text-lg font-black">{selectedBall.owner ?? 'Unassigned'}</p>
                  <p className="text-sm text-white/70">Paid until and including {selectedBall.paidUntil}</p>
                </div>
              )}
            </div>
          </div>
        )}

          {/* INBOX */}
          {showInbox && (
            <div className="fixed inset-0 z-[200] flex flex-col bg-[#020407]">
              <header className="p-8 flex items-center justify-between border-b border-white/10">
                <h3 className="text-3xl font-black text-white uppercase">Notifications</h3>
                <button
                  onClick={() => setShowInbox(false)}
                  className="text-white/40 hover:text-white"
                >
                  ✕
                </button>
              </header>

              <div className="flex-1 overflow-y-auto p-8 space-y-6">
                {notifications.length === 0 ? (
                  <p className="text-center text-white/30 uppercase text-xs">No alerts</p>
                ) : (
                  notifications.map((n) => (
                    <div key={n.id} className="bg-white/5 border border-white/10 p-6 rounded-2xl">
                      <h5 className="font-black text-white mb-2">{n.title}</h5>
                      <p className="text-white/60 text-sm">{n.body}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* RECOVERY MODAL (blocking) */}
          {isRecoveryMode && (
            <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-black/90 backdrop-blur-2xl">
              <div className="w-full max-w-md bg-[#0b0f16] border border-pink-500/40 rounded-[2rem] p-8 text-center shadow-2xl">
                <h3 className="text-2xl font-black text-white mb-3">Set a New Password</h3>
                <p className="text-white/60 text-sm mb-6">For security, please choose a new password before continuing.</p>
                <form onSubmit={handleRecoveryPasswordSubmit} className="space-y-4">
                  <input
                    type="password"
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-pink-500"
                    placeholder="New password"
                  />
                  <button
                    type="submit"
                    disabled={!newPassword || isUpdatingPassword}
                    className="w-full py-4 bg-pink-500 text-black font-black uppercase tracking-widest text-xs rounded-xl disabled:opacity-40"
                  >
                    {isUpdatingPassword ? 'Updating...' : 'Update Password'}
                  </button>
                </form>
              </div>
            </div>
          )}
        </>
      ) : (
  /* Login / Register */
  <main className="relative z-10 flex-1 flex flex-col items-center justify-center p-6">
    {/* Background balls */}
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full pointer-events-none opacity-20 overflow-hidden">
      {smallBalls.map(ball => (
        <div
          key={ball.id}
          className="absolute"
          style={{
            left: ball.x,
            top: ball.y,
            width: ball.radius * 2,
            height: ball.radius * 2,
            transform: "translate(-50%, -50%)",
          }}
        >
          <LotteryBall
            number={ball.num}
            hideShadow
            className="w-full h-full"
            opacity={0.3}
            blur="1px"
          />
        </div>
      ))}
    </div>

    {/* Logo / Title */}
    <div className="relative z-10 text-center mb-12">
      <div className="w-16 h-16 rounded-full bg-pink-500 mx-auto flex items-center justify-center text-black font-black text-sm mb-6 shadow-2xl animate-bounce">
        DWA
      </div>
      <h1 className="text-7xl font-black text-white tracking-tighter uppercase leading-none">
        Bonus
        <br />
        <span className="text-pink-500">Ball</span>
      </h1>
      <p className="text-[10px] font-black uppercase tracking-[0.5em] text-white/20 mt-4">
        In Memory of Emmie-Rose
      </p>
    </div>

   <div className="w-full max-w-md bg-white/[0.03] backdrop-blur-3xl border border-white/10 p-10 rounded-[3rem] shadow-2xl relative z-10 animate-in fade-in slide-in-from-bottom-10 duration-700">
  {/* LOGIN */}
  {authMode === "login" && (
    <form onSubmit={handleLogin} className="space-y-6">
      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">
          Email
        </label>
        <input
          name="email"
          required
          type="email"
          className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all"
        />
      </div>

      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">
          Password
        </label>
        <input
          name="password"
          required
          type="password"
          className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all"
        />
      </div>

      <button
        type="submit"
        className="w-full py-5 bg-white text-black font-black uppercase text-xs tracking-[0.3em] rounded-2xl hover:bg-pink-500 hover:text-white transition-all"
      >
        Enter Platform
      </button>

      <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-white/30">
        <button type="button" onClick={() => setAuthMode("register")} className="hover:text-white">
          Register
        </button>
        <button type="button" onClick={() => setAuthMode("forgot")} className="hover:text-white">
          Forgot password?
        </button>
      </div>
    </form>
  )}

  {/* REGISTER */}
  {authMode === "register" && (
    <form onSubmit={handleRegister} className="space-y-6">
      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">
          Email
        </label>
        <input
          name="email"
          required
          type="email"
          className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all"
        />
      </div>

      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">
          Password
        </label>
        <input
          name="password"
          required
          type="password"
          className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all"
        />
      </div>

      <button
        type="submit"
        className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-[0.3em] rounded-2xl hover:bg-pink-400 transition-all"
      >
        Create Account
      </button>

      <button
        type="button"
        onClick={() => setAuthMode("login")}
        className="w-full text-[10px] font-black uppercase tracking-widest text-white/30 hover:text-white transition-all"
      >
        Already have an account?
      </button>
    </form>
  )}

  {/* FORGOT PASSWORD */}
  {authMode === "forgot" && (
    <form onSubmit={handleForgotPassword} className="space-y-6">
      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">
          Email
        </label>
        <input
          name="email"
          required
          type="email"
          className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all"
        />
      </div>

      <button
        type="submit"
        className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-[0.3em] rounded-2xl hover:bg-pink-400 transition-all"
      >
        Send reset email
      </button>

      <button
        type="button"
        onClick={() => setAuthMode("login")}
        className="w-full text-[10px] font-black uppercase tracking-widest text-white/30 hover:text-white transition-all"
      >
        Back to login
      </button>
    </form>
  )}

{/* RESET PASSWORD */}
{authMode === "reset" && (
  <form onSubmit={handleResetPassword} className="space-y-6">
    <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">
          New Password
        </label>
        <input
          name="password"
          required
          type="password"
          className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all"
        />
      </div>

      <button
        type="submit"
      className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-[0.3em] rounded-2xl hover:bg-pink-400 transition-all"
  >
    Set new password
  </button>
</form>
)}
    </div>
  </main>
    )}
  </div>
  );
};

export default App;
