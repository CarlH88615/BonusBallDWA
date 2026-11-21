// gitupdate 
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LotteryBall } from './components/LotteryBall';
import { ScratchReveal } from './components/ScratchReveal';
import { supabase, DEMO_ROLE, DEMO_ADMIN_EMAIL } from "./services/supabase";
import type { BallState, NotificationMessage, Tab, AuthMode } from './types';





const ADMIN_EMAIL = 'Carlwhalliday@icloud.com';
const TEST_EMAIL = 'test@user.com';

// Pulled from env so the PIN isn't visible in source. Set VITE_ADMIN_PIN in .env.local
// and in the Netlify env. If unset, hard reset is disabled.
const ADMIN_PIN = ((import.meta as any).env?.VITE_ADMIN_PIN ?? "") as string;
const VAPID_PUBLIC_KEY = ((import.meta as any).env?.VITE_VAPID_PUBLIC_KEY ?? "") as string;

// Draws are locked to Saturday 20:00 UK-local. These helpers keep all date math in local
// time so we never trip on UTC/BST shifts.
const formatLocalDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const computeUpcomingSaturday = (): string => {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0, 0, 0);
  if (candidate.getDay() === 6 && now < candidate) {
    return formatLocalDate(candidate);
  }
  const daysToAdd = candidate.getDay() === 6 ? 7 : (6 - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + daysToAdd);
  return formatLocalDate(candidate);
};

const isFutureSaturday = (dateStr: string): boolean => {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d, 20, 0, 0, 0);
  return dt.getDay() === 6 && dt > new Date();
};

const saturdayIso = (dateStr: string): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 20, 0, 0, 0).toISOString();
};

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
  
  type RevealStyle = 'scratch' | 'slot' | 'bingo' | 'tile' | 'curtain';
  const REVEAL_STYLES: { value: RevealStyle; label: string }[] = [
    { value: 'scratch', label: 'Scratch Off' },
    { value: 'slot', label: 'Slot Machine' },
    { value: 'bingo', label: 'Bingo Eliminate' },
    { value: 'tile', label: 'Tile Flip' },
    { value: 'curtain', label: 'Stage Curtain' },
  ];
  const [revealDefaultStyle, setRevealDefaultStyle] = useState<RevealStyle>(() => {
    if (typeof window === 'undefined') return 'scratch';
    // v2 key: the redesign makes Scratch Off the default, ignoring any older saved choice.
    const saved = localStorage.getItem('reveal_default_style_v2');
    if (saved === 'scratch' || saved === 'slot' || saved === 'bingo' || saved === 'tile' || saved === 'curtain') return saved;
    return 'scratch';
  });
  const setAsDefaultStyle = (style: RevealStyle) => {
    localStorage.setItem('reveal_default_style_v2', style);
    setRevealDefaultStyle(style);
    showToast('success', `Default reveal set to ${REVEAL_STYLES.find((s) => s.value === style)?.label}`);
  };
  // Per-draw override chosen in the Record Result modal. Empty string = use default.
  const [recordRevealStyle, setRecordRevealStyle] = useState<RevealStyle | ''>('');
  const [revealStyle, setRevealStyle] = useState<RevealStyle>('scratch');
  const [revealRun, setRevealRun] = useState(0); // bumps on every play so Scratch Off remounts with fresh foil
  const [revealStep, setRevealStep] = useState<'idle' | 'running' | 'settled'>('idle');
  // Per-style state. Each style only reads what it needs.
  const [slotNumber, setSlotNumber] = useState<number>(1);
  const [bingoGrid, setBingoGrid] = useState<Array<{ num: number; eliminated: boolean }>>([]);
  const [bingoFinale, setBingoFinale] = useState<{
    phase: 'idle' | 'rally' | 'shake3' | 'elim1' | 'shake2' | 'elim2' | 'crown';
    finalists: number[]; // 3 ball numbers in randomised display order
    winnerIdx: number;   // which display position holds the actual winner
    elimOrder: number[]; // the two non-winner display indices, in elimination order
  }>({ phase: 'idle', finalists: [], winnerIdx: -1, elimOrder: [] });
  const [tileGrid, setTileGrid] = useState<Array<{ num: number; flipped: boolean; display: number }>>([]);
  const [curtainPhase, setCurtainPhase] = useState<'closed' | 'shake' | 'opening' | 'open'>('closed');
  const revealRequestRef = useRef<number>(null);
  const revealTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [smallBalls, setSmallBalls] = useState<BallState[]>([]);
  const [selectedBallNum, setSelectedBallNum] = useState<number | null>(null);

  // PLATFORM STATE - STARTING BLANK
  const [notifications, setNotifications] = useState<NotificationMessage[]>([]);
  const [noticeDismissed, setNoticeDismissed] = useState<boolean>(
    typeof window !== 'undefined' && localStorage.getItem('notice_v1_dismissed') === 'true'
  );
  const [seenOnboarding, setSeenOnboarding] = useState<boolean>(
    typeof window !== 'undefined' && localStorage.getItem('onboarding_v1_seen') === 'true'
  );
  const [dangerOpen, setDangerOpen] = useState(false);
  const dismissNotice = () => {
    localStorage.setItem('notice_v1_dismissed', 'true');
    setNoticeDismissed(true);
  };
  const completeOnboarding = () => {
    localStorage.setItem('onboarding_v1_seen', 'true');
    setSeenOnboarding(true);
  };
  // Audio: generated tones via Web Audio API, no external assets. AudioContext is created
  // lazily on first user interaction (browser autoplay policies).
  const [muted, setMuted] = useState<boolean>(
    typeof window !== 'undefined' && localStorage.getItem('reveal_muted') === 'true'
  );
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ensureAudio = (): AudioContext | null => {
    if (muted) return null;
    if (!audioCtxRef.current) {
      try {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch {
        return null;
      }
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    return audioCtxRef.current;
  };
  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    localStorage.setItem('reveal_muted', String(next));
  };
  const playTone = (freq: number, durationMs: number, volume = 0.15, type: OscillatorType = 'square') => {
    const ctx = ensureAudio(); if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  };
  const playTick = () => playTone(1400, 30, 0.08, 'square');
  const playClick = () => playTone(800, 50, 0.10, 'triangle');
  const playThunk = () => {
    const ctx = ensureAudio(); if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.35);
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.45, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  };
  const playChime = (freq: number, durMs = 700) => {
    const ctx = ensureAudio(); if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durMs / 1000);
    osc.start();
    osc.stop(ctx.currentTime + durMs / 1000);
  };
  const playFanfare = () => {
    // C major ascending then big top note
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => playChime(f, 600), i * 90));
  };
  const playSad = () => {
    // Minor-third descending for rollover (no winner)
    [392, 330, 262].forEach((f, i) => setTimeout(() => playChime(f, 500), i * 180));
  };
  const playExplosion = () => {
    const ctx = ensureAudio(); if (!ctx) return;
    const bufferSize = Math.floor(ctx.sampleRate * 0.4);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    noise.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    noise.start();
    noise.stop(ctx.currentTime + 0.4);
  };
  const playWhoosh = () => {
    const ctx = ensureAudio(); if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.6);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 600;
    filter.Q.value = 2;
    osc.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.start();
    osc.stop(ctx.currentTime + 0.8);
  };

  const [toast, setToast] = useState<{ kind: 'error' | 'success' | 'info'; message: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (kind: 'error' | 'success' | 'info', message: string) => {
    setToast({ kind, message });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };
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
  const [bankBalance, setBankBalance] = useState<number>(0);
  const fetchBankBalance = async (): Promise<number> => {
    const { data, error } = await supabase
      .from("bonus_ball_bank")
      .select("balance")
      .single();
    if (error) {
      console.error("❌ Failed to load bank", error);
      return bankBalance;
    }
    const next = (data as any)?.balance ?? 0;
    setBankBalance(next);
    return next;
  };
  // Race-safe bank delta: refetch latest balance from DB, then write balance + delta.
  const adjustBank = async (delta: number): Promise<number | null> => {
    const current = await fetchBankBalance();
    const newBalance = current + delta;
    const { error } = await supabase
      .from("bonus_ball_bank")
      .update({ balance: newBalance })
      .eq("id", 1);
    if (error) {
      console.error("❌ adjustBank failed", error);
      return null;
    }
    setBankBalance(newBalance);
    return newBalance;
  };
  // Maps a ledger row's effect on the bank balance. Adjustment amounts are signed; the
  // other types are stored as positive magnitudes with implied sign.
  const ledgerEffectOnBank = (type: string, amount: number | string): number => {
    const a = Number(amount) || 0;
    switch (type) {
      case "deposit": return +a;
      case "paid_win": return -a;
      case "charity": return -a;
      case "adjustment": return +a;
      default: return 0;
    }
  };
  // helper removed: single-row model updates state.balls directly
  const [resetPin, setResetPin] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const [ledgerRows, setLedgerRows] = useState<any[]>([]);
  const [newEntryType, setNewEntryType] = useState<"deposit" | "paid_win" | "charity" | "adjustment">("deposit");
  const [newEntryAmount, setNewEntryAmount] = useState<string>("");
  const [newEntryNotes, setNewEntryNotes] = useState<string>("");
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [deliveryMode, setDeliveryMode] = useState<"push" | "inapp">("push");
  const [scheduleMode, setScheduleMode] = useState<"now" | "once" | "recurring">("now");
  const [scheduleOnceDate, setScheduleOnceDate] = useState<string>('');
  const [scheduleOnceTime, setScheduleOnceTime] = useState<string>('');
  const [recurringDay, setRecurringDay] = useState<string>('Sat');
  const [recurringTime, setRecurringTime] = useState<string>('20:00');
  const [scheduledNotifications, setScheduledNotifications] = useState([]);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [adminSearchTerm, setAdminSearchTerm] = useState('');
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const requestRef = useRef<number>(null);

  const [totalRollover, setTotalRollover] = useState(0);
  const [members, setMembers] = useState([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");

  // DYNAMIC CALCULATIONS
const isAdmin = useMemo(() => {
  if (!sessionEmail) return false;
  if (DEMO_ROLE === 'admin' && sessionEmail === DEMO_ADMIN_EMAIL) return true; // local demo only
  return sessionEmail.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}, [sessionEmail]);

  // Count balls paid through the upcoming draw. The legacy managedBallData store was
  // session-only and never re-hydrated from DB, so it always read as zero.
  const deleteScheduled = async (id) => {
    await supabase
      .from("scheduled_notifications")
      .delete()
      .eq("id", id);

    setScheduledNotifications((prev) =>
      prev.filter((item) => item.id !== id)
    );
  };

  const reloadLedger = async () => {
    const { data, error } = await supabase
      .from("bonus_ball_ledger")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("❌ Failed to reload ledger", error);
      return;
    }
    setLedgerRows(data ?? []);
  };

  const addManualEntry = async () => {
    if (!isAdmin) return;
    const raw = parseFloat(newEntryAmount);
    if (isNaN(raw) || raw === 0) {
      showToast("error", "Enter a non-zero amount.");
      return;
    }
    // Adjustments accept signed input; other types accept positive magnitudes only.
    const amount = newEntryType === "adjustment" ? raw : Math.abs(raw);
    setLedgerBusy(true);
    try {
      const { error: insertErr } = await supabase
        .from("bonus_ball_ledger")
        .insert([{
          type: newEntryType,
          amount,
          reference: "Manual entry",
          notes: newEntryNotes || null,
        }]);
      if (insertErr) {
        console.error("❌ Insert manual entry failed", insertErr);
        showToast("error", "Failed to save entry.");
        return;
      }
      await adjustBank(ledgerEffectOnBank(newEntryType, amount));
      await reloadLedger();
      setNewEntryAmount("");
      setNewEntryNotes("");
    } finally {
      setLedgerBusy(false);
    }
  };

  const deleteLedgerEntry = async (row: any) => {
    if (!isAdmin) return;
    if (!confirm(`Delete this ${row.type} entry for £${row.amount}? Bank will be adjusted to reverse it.`)) return;
    setLedgerBusy(true);
    try {
      const { error: delErr } = await supabase
        .from("bonus_ball_ledger")
        .delete()
        .eq("id", row.id);
      if (delErr) {
        console.error("❌ Delete ledger entry failed", delErr);
        showToast("error", "Failed to delete.");
        return;
      }
      await adjustBank(-ledgerEffectOnBank(row.type, row.amount));
      await reloadLedger();
    } finally {
      setLedgerBusy(false);
    }
  };

  const upcomingDrawDateTime = useMemo(() => {
    if (!drawDate) return null;
    const [y, m, d] = drawDate.split('-').map(Number);
    return new Date(y, m - 1, d, 20, 0, 0, 0);
  }, [drawDate]);
  const upcomingDrawDate = upcomingDrawDateTime;
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
    if (!upcomingDrawDateTime) return '';
    return upcomingDrawDateTime.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }, [upcomingDrawDateTime]);

  // True once the open draw's 8pm slot is in the past — i.e. the draw has happened but
  // the admin hasn't recorded a winner yet.
  const drawAwaitingResult = useMemo(() => {
    if (!upcomingDrawDateTime) return false;
    return upcomingDrawDateTime.getTime() < Date.now();
  }, [upcomingDrawDateTime]);

  // Returns number of draws this ball is paid through, counting the upcoming draw as 1.
  // Declared before any useMemo that calls it so we don't trip the TDZ on first render.
  const weeksCoveredFor = (ball: any): number => {
    if (!ball?.paidUntil || !upcomingDrawDateTime) return 0;
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const paid = new Date(ball.paidUntil);
    paid.setHours(20, 0, 0, 0);
    if (paid < upcomingDrawDateTime) return 0;
    return Math.floor((paid.getTime() - upcomingDrawDateTime.getTime()) / weekMs) + 1;
  };

  // Consecutive most-recent draws with no paid winner. Drives the rollover-streak banner.
  const rolloverStreak = useMemo(() => {
    let streak = 0;
    for (const r of winnerRows as any[]) {
      if (!r.winner_name || Number(r.amount_won) === 0) streak += 1;
      else break;
    }
    return streak;
  }, [winnerRows]);

  // Balls that have an owner but aren't covered for the upcoming draw. Surfaces them at
  // the top of admin so the admin can chase payment without scrolling the full grid.
  const ballsDueThisWeek = useMemo(() => {
    if (!upcomingDrawDateTime) return [];
    return balls.filter((b) => {
      if (!b?.owner) return false;
      if (!b.paidUntil) return true;
      const paid = new Date(b.paidUntil);
      paid.setHours(20, 0, 0, 0);
      return paid < upcomingDrawDateTime;
    });
  }, [balls, upcomingDrawDateTime]);

  // Members enriched with how many balls they own and total weeks remaining.
  const membersWithStats = useMemo(() => {
    return (members as any[]).map((m) => {
      const owned = balls.filter((b) => b?.email && b.email.toLowerCase() === (m.email ?? '').toLowerCase());
      const totalWeeks = owned.reduce((sum, b) => sum + weeksCoveredFor(b), 0);
      return { ...m, ballNumbers: owned.map((b) => b.number), totalWeeks };
    });
  }, [members, balls, upcomingDrawDateTime]);

  const removeMember = async (memberId: string, memberName: string) => {
    if (!isAdmin) return;
    if (!confirm(`Remove ${memberName}? This unlinks them from the app — any balls they own keep the owner name but lose the registered-user link.`)) return;
    const { error } = await supabase.from("members").delete().eq("id", memberId);
    if (error) {
      showToast("error", "Failed to remove member.");
      return;
    }
    setMembers((prev: any[]) => prev.filter((m) => m.id !== memberId));
    showToast("success", `${memberName} removed.`);
  };

  const myBalls = useMemo(() => {
    if (!sessionEmail) return [];
    const me = sessionEmail.toLowerCase();
    return balls.filter((b) => b?.email && b.email.toLowerCase() === me);
  }, [balls, sessionEmail]);

  const paidCount = useMemo(() => {
    if (!upcomingDrawDateTime) return 0;
    return balls.reduce((acc, ball) => {
      if (!ball?.paidUntil) return acc;
      const paid = new Date(ball.paidUntil);
      paid.setHours(20, 0, 0, 0);
      return paid >= upcomingDrawDateTime ? acc + 1 : acc;
    }, 0);
  }, [balls, upcomingDrawDateTime]);

  // Sum of every ball's prepaid weeks × £2 (only counting weeks at or beyond the upcoming draw).
  // This is the truth-source for what should be in the bank from member contributions.
  const expectedFromBalls = useMemo(() => {
    if (!upcomingDrawDateTime) return 0;
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    return balls.reduce((sum, ball) => {
      if (!ball?.paidUntil) return sum;
      const paidUntil = new Date(ball.paidUntil);
      paidUntil.setHours(20, 0, 0, 0);
      if (paidUntil < upcomingDrawDateTime) return sum;
      const weeks = Math.floor((paidUntil.getTime() - upcomingDrawDateTime.getTime()) / weekMs) + 1;
      return sum + weeks * 2;
    }, 0);
  }, [balls, upcomingDrawDateTime]);

  const expectedBankTotal = expectedFromBalls + (Number(totalRollover) || 0);

  const ledgerNet = useMemo(
    () => ledgerRows.reduce((sum, row) => sum + ledgerEffectOnBank(row.type, row.amount), 0),
    [ledgerRows]
  );

  // Ledger sorted newest-first for display, with a running balance ("balance after this entry").
  const ledgerWithRunning = useMemo(() => {
    const oldestFirst = [...ledgerRows].reverse();
    let running = 0;
    const enriched = oldestFirst.map((row) => {
      running += ledgerEffectOnBank(row.type, row.amount);
      return { ...row, runningBalance: running };
    });
    return enriched.reverse();
  }, [ledgerRows]);

  const formatPaidUntil = (iso?: string) => {
    if (!iso) return '';

    const date = new Date(iso);

    return `${date.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    })} 8pm`;
  };
  // Pulled from DB-backed winners table (newest completed paid winner). The legacy
  // pastResults store was session-only and never hydrated, so the Saturday reveal
  // animation was effectively dead.
  const latestWin = useMemo(() => {
    // Most recent completed draw — INCLUDES rollovers (no winner_name) so the reveal
    // still plays and the home card still updates after every draw, not just paid ones.
    const completed = (winnerRows ?? []).find((r: any) => r.winning_number);
    if (!completed) return null;
    const persistedStyle = (completed.reveal_style as RevealStyle | undefined) ?? null;
    const styleForPlayback: RevealStyle =
      persistedStyle === 'scratch' || persistedStyle === 'slot' || persistedStyle === 'bingo' || persistedStyle === 'tile' || persistedStyle === 'curtain'
        ? persistedStyle
        : revealDefaultStyle;
    return {
      id: completed.id,
      date: completed.draw_date,
      ballNumber: Number(completed.winning_number),
      winner: completed.winner_name,
      prizeAmount: Number(completed.amount_won) || 0,
      charityAmount: 0,
      rolloverAmount: Number(completed.rollover_amount) || 0,
      isRollover: !completed.winner_name,
      revealStyle: styleForPlayback,
    };
  }, [winnerRows, revealDefaultStyle]);
  const handleRecordResult = async () => {
    if (!selectedResultBall) return;
    const ball = balls.find(b => b.number === selectedResultBall);
    const isPaidWinner = (() => {
      if (!ball?.owner) return false;
      if (!ball?.paidUntil || !upcomingDrawDateTime) return false;
      const paidDate = new Date(ball.paidUntil);
      const normalized = new Date(paidDate);
      normalized.setHours(20, 0, 0, 0);
      return normalized >= upcomingDrawDateTime;
    })();
    const isUnpaidWinner = !isPaidWinner; // vacant or assigned-but-unpaid
    const paidPot = currentPot - totalRollover; // only payments covering this draw
    const rolloverPersist = isPaidWinner ? 0 : totalRollover + paidPot;
    const amountWon = isPaidWinner ? paidPot + totalRollover : 0;
    setTotalRollover(rolloverPersist);
    setRolloverAmount(rolloverPersist);
    const drawDate = upcomingDrawDateTime.toISOString().split('T')[0];
    const drawTimestamp = upcomingDrawDateTime.toISOString();
    const winnerName = ball?.owner ?? null;

    try {
      // Fetch open draw row
      const { data: openRow, error: fetchOpenErr } = await supabase
        .from("bonus_ball_winners")
        .select("*")
        .eq("status", "open")
        .single();
      if (fetchOpenErr || !openRow) {
        console.error("❌ Failed to fetch open draw", fetchOpenErr);
        showToast("error", "Couldn't find the open draw. Nothing was saved.");
        return;
      }

      // Current draw is always Saturday — next draw is exactly 7 local days later (also Saturday).
      const [cy, cm, cd] = openRow.draw_date.split('-').map(Number);
      const nextLocal = new Date(cy, cm - 1, cd, 20, 0, 0, 0);
      nextLocal.setDate(nextLocal.getDate() + 7);
      const nextDrawDateStr = `${nextLocal.getFullYear()}-${String(nextLocal.getMonth() + 1).padStart(2, '0')}-${String(nextLocal.getDate()).padStart(2, '0')}`;
      const nextDrawTimestampIso = nextLocal.toISOString();

      // Update open row to completed. reveal_style is the override (or default).
      const chosenStyle: RevealStyle = (recordRevealStyle as RevealStyle) || revealDefaultStyle;
      const updatePayload: Record<string, any> = {
        status: "completed",
        winning_number: selectedResultBall,
        winner_name: winnerName,
        amount_won: amountWon,
        rollover_amount: rolloverPersist,
        completed_at: new Date().toISOString(),
        reveal_style: chosenStyle,
      };
      let { error: updateErr } = await supabase
        .from("bonus_ball_winners")
        .update(updatePayload)
        .eq("id", openRow.id);
      // Graceful fallback if the reveal_style column hasn't been added yet to Supabase.
      if (updateErr && /reveal_style/i.test(updateErr.message || '')) {
        console.warn("reveal_style column missing — retrying without it. Run the SQL in admin to enable per-draw styles.");
        delete updatePayload.reveal_style;
        const retry = await supabase
          .from("bonus_ball_winners")
          .update(updatePayload)
          .eq("id", openRow.id);
        updateErr = retry.error;
      }
      if (updateErr) {
        console.error("❌ Failed to record winner", updateErr);
        showToast("error", "Couldn't save the result. Nothing was changed.");
        return;
      }
      console.log("✅ Winner recorded");
      setRecordRevealStyle(''); // reset for next time

      // Insert next open row
      const { error: newOpenErr } = await supabase
        .from("bonus_ball_winners")
        .insert([
          {
            draw_date: nextDrawDateStr,
            draw_timestamp: nextDrawTimestampIso,
            status: "open",
            rollover_amount: rolloverPersist,
          },
        ]);
      if (newOpenErr) {
        console.error("❌ Failed to create next open draw", newOpenErr);
        showToast("error", "Result saved, but next week's draw wasn't created. Check before taking payments.");
        return;
      }
      setDrawDate(nextDrawDateStr);
      setSelectedResultBall(null);
      showToast("success", isPaidWinner ? `Saved. ${winnerName} wins £${amountWon}.` : `Saved. £${rolloverPersist} rolls over.`);
      if (notifyOnResult) {
        sendPush("Saturday's ball is in", "Open Bonus Ball and scratch to see if it's yours.", "all", "win");
      }

      // Update bank only when a paid winner takes money out. Unpaid wins roll 100% forward, so no bank/ledger movement.
      if (isPaidWinner) {
        const bankDelta = -(paidPot + totalRollover);
        const newBalance = await adjustBank(bankDelta);
        if (newBalance !== null) {
          const { error: ledgerErr } = await supabase
            .from("bonus_ball_ledger")
            .insert([
              {
                type: "paid_win",
                amount: Math.abs(bankDelta),
                reference: `Draw ${drawDate}`,
                notes: `Paid winner - Ball ${selectedResultBall}`,
              },
            ]);
          if (ledgerErr) {
            console.error("❌ Failed to write ledger entry", ledgerErr);
          }
          reloadLedger();
        }
      }

      // Reload winners list
      const { data, error: fetchErr } = await supabase
        .from("bonus_ball_winners")
        .select("*")
        .order("draw_date", { ascending: false });
      if (fetchErr) {
        console.error("❌ Failed to load winners", fetchErr);
        return;
      }
      setWinnerRows(data ?? []);
    } catch (err) {
      console.error("❌ Unexpected error in handleRecordResult", err);
      showToast("error", "Something went wrong saving the result.");
    }
  };
  const handleHardReset = async () => {
    if (!isAdmin) return;
    if (!ADMIN_PIN) {
      showToast("error", "Hard reset disabled — VITE_ADMIN_PIN not configured.");
      return;
    }
    if (resetPin !== ADMIN_PIN) {
      showToast("error", "Incorrect PIN");
      return;
    }
    if (!confirm("This cannot be undone. Proceed with hard reset?")) return;
    setIsResetting(true);
    try {
      // build fresh canonical ball set
      const freshBalls = Array.from({ length: 59 }, (_, i) => ({
        number: i + 1,
        ownerName: null,
        owner: null,
        userId: null,
        email: null,
        paidUntil: null,
      }));

      const winnerDelete = await supabase
        .from("bonus_ball_winners")
        .delete()
        .not("id", "is", null);
      if (winnerDelete.error) throw winnerDelete.error;

      const bankReset = await supabase
        .from("bonus_ball_bank")
        .update({ balance: 0 })
        .eq("id", 1)
        .single();
      if (bankReset.error) throw bankReset.error;

      const targetId = bonusBallRowId ?? 1;
      const ballsReset = await supabase
        .from("bonus_ball_data")
        .update({ state: { balls: freshBalls } })
        .eq("id", targetId)
        .single();
      if (ballsReset.error) throw ballsReset.error;

      setBalls(freshBalls);
      setTotalRollover(0);
      setRolloverAmount(0);
      setSelectedBallNum(null);
      setWinnerRows([]);
      setBankBalance(bankReset.data?.balance ?? 0);
      fetchBankBalance();
      loadBallsFromDb();
    } catch (err) {
      console.error("❌ Hard reset failed", err);
      showToast("error", "Reset failed. Check console for details.");
    } finally {
      setIsResetting(false);
      setResetPin('');
    }
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
    showToast("error", error.message);
    return;
  }

  const signedInEmail = data.user?.email ?? email;
  setUserEmail(signedInEmail);

  if (latestWin) checkReveal();
};


  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();

  const formData = new FormData(e.currentTarget);
  const fullName = String(formData.get("fullName") ?? "");
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    showToast("error", error.message);
    return;
  }

  if (data?.user) {
    await supabase.from("members").insert({
      id: data.user.id,
      email: data.user.email,
      full_name: fullName
    });
  }

  // If email confirmations are ON, session may be null until confirmed.
  const signedUpEmail = data.user?.email ?? email;
  setUserEmail(signedUpEmail);

  // Try to immediately log in if a session exists (confirmations OFF).
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) {
    sendPush("Welcome", "Your account has been successfully created.", "admin", "reminder");
  } else {
    showToast("info", "Account created. Please check your email to confirm, then log in.");
  }
};


  // Auto-plays the reveal once per paid draw the user hasn't watched yet. Keyed by the
  // draw row id (stable) rather than a computed date string.
  const checkReveal = () => {
    if (!latestWin || !(latestWin as any).id) return;
    const key = 'seen_reveal_id_' + (latestWin as any).id;
    if (localStorage.getItem(key) === 'true') return;
    // Don't mark seen yet — only set the flag when the user actually dismisses the
    // modal. Otherwise an auto-fire that happens while the user is on another tab
    // (or before they engage with the page) would be "spent" silently.
    startRevealSequence(latestWin.revealStyle);
  };

  const dismissReveal = () => {
    cancelRevealAnimations();
    setShowWinReveal(false);
    if (latestWin && (latestWin as any).id) {
      localStorage.setItem('seen_reveal_id_' + (latestWin as any).id, 'true');
    }
  };

  // Whether the user has watched the reveal for the latest paid draw. Drives whether
  // the home-page winner card is shown (hidden = avoid spoilers before the reveal plays).
  const hasSeenLatestReveal = useMemo(() => {
    if (!latestWin || !(latestWin as any).id) return true;
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('seen_reveal_id_' + (latestWin as any).id) === 'true';
  }, [latestWin, showWinReveal]);

  // Auto-play the reveal the first time a signed-in user opens the app after a draw.
  // Gated on sessionEmail so the splash/login screen doesn't fire the reveal.
  useEffect(() => {
    if (!sessionEmail) return;
    if (latestWin && (latestWin as any).id && !hasSeenLatestReveal && !showWinReveal) {
      const t = setTimeout(() => checkReveal(), 400);
      return () => clearTimeout(t);
    }
  }, [sessionEmail, latestWin, hasSeenLatestReveal]);

  // Shared teardown: cancel everything previously scheduled by any reveal style.
  const cancelRevealAnimations = () => {
    if (revealRequestRef.current != null) {
      cancelAnimationFrame(revealRequestRef.current);
      revealRequestRef.current = null;
    }
    revealTimeoutsRef.current.forEach((t) => clearTimeout(t));
    revealTimeoutsRef.current = [];
  };

  const startSlotReveal = (winNum: number, isRollover: boolean) => {
    const total = 6500;
    const start = performance.now();
    let tickCount = 0;
    const tick = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= total) {
        setSlotNumber(winNum);
        setRevealStep('settled');
        revealRequestRef.current = null;
        playThunk();
        setTimeout(() => (isRollover ? playSad() : playFanfare()), 250);
        return;
      }
      const progress = elapsed / total;
      const intervalMs = 50 + Math.pow(progress, 3) * 700;
      if (total - elapsed < 600) {
        const candidates = [winNum, winNum, ((winNum + 17) % 59) + 1, winNum];
        setSlotNumber(candidates[Math.floor(elapsed / 150) % candidates.length]);
      } else {
        setSlotNumber(Math.floor(Math.random() * 59) + 1);
      }
      // Every 2nd tick to avoid audio overload at fast cycle speeds
      if (tickCount % 2 === 0) playTick();
      tickCount++;
      const t = setTimeout(tick, intervalMs);
      revealTimeoutsRef.current.push(t);
    };
    tick();
  };

  const startBingoReveal = (winNum: number, isRollover: boolean) => {
    // Build the 59-ball grid in numerical order
    const grid = Array.from({ length: 59 }, (_, i) => ({ num: i + 1, eliminated: false }));
    setBingoGrid(grid);
    setBingoFinale({ phase: 'idle', finalists: [] });

    // Pick 2 random non-winners to be the other finalists; eliminate everyone else first.
    const nonWinnerNums = grid.map((b) => b.num).filter((n) => n !== winNum);
    const shuffled = [...nonWinnerNums].sort(() => Math.random() - 0.5);
    const otherFinalists = shuffled.slice(0, 2);
    const toEliminateInGrid = shuffled.slice(2); // 56 balls

    // Phase 1: fast grid eliminations until only the 3 finalists remain.
    let i = 0;
    const eliminateOne = () => {
      if (i >= toEliminateInGrid.length) {
        // Hold for a beat, then transition into finale rally
        const t = setTimeout(() => beginFinale(), 350);
        revealTimeoutsRef.current.push(t);
        return;
      }
      const targetNum = toEliminateInGrid[i];
      setBingoGrid((prev) => prev.map((b) => (b.num === targetNum ? { ...b, eliminated: true } : b)));
      // Subtle pop on each elimination — frequency varies for texture
      playTone(280 + (targetNum * 7) % 200, 60, 0.10, 'triangle');
      i++;
      const remaining = toEliminateInGrid.length - i;
      let delay: number;
      if (i < 6) delay = 220 - i * 15;          // ease in
      else if (remaining < 4) delay = 180 + (4 - remaining) * 90; // build tension as we approach finale
      else delay = 50;                            // rip through the middle
      const t = setTimeout(eliminateOne, delay);
      revealTimeoutsRef.current.push(t);
    };

    const beginFinale = () => {
      // Sort numerically so the winner's screen position varies naturally with their
      // number — no positional tell. Randomise which of the two losers explodes first.
      const finalists = [otherFinalists[0], otherFinalists[1], winNum].sort((a, b) => a - b);
      const winnerIdx = finalists.indexOf(winNum);
      const loserIdxs = [0, 1, 2].filter((i) => i !== winnerIdx);
      const elimOrder = Math.random() < 0.5 ? loserIdxs : [loserIdxs[1], loserIdxs[0]];
      setBingoFinale({ phase: 'rally', finalists, winnerIdx, elimOrder });
      playWhoosh();
      const tShake = setTimeout(() => setBingoFinale((s) => ({ ...s, phase: 'shake3' })), 800);
      const tElim1 = setTimeout(() => { setBingoFinale((s) => ({ ...s, phase: 'elim1' })); playExplosion(); }, 2200);
      const tShake2 = setTimeout(() => setBingoFinale((s) => ({ ...s, phase: 'shake2' })), 3000);
      const tElim2 = setTimeout(() => { setBingoFinale((s) => ({ ...s, phase: 'elim2' })); playExplosion(); }, 4400);
      const tCrown = setTimeout(() => {
        setBingoFinale((s) => ({ ...s, phase: 'crown' }));
        setRevealStep('settled');
        playThunk();
        setTimeout(() => (isRollover ? playSad() : playFanfare()), 250);
      }, 5300);
      revealTimeoutsRef.current.push(tShake, tElim1, tShake2, tElim2, tCrown);
    };

    const first = setTimeout(eliminateOne, 600);
    revealTimeoutsRef.current.push(first);
  };

  const startTileReveal = (winNum: number, isRollover: boolean) => {
    const grid = Array.from({ length: 59 }, (_, i) => ({
      num: i + 1,
      flipped: false,
      display: Math.floor(Math.random() * 59) + 1,
    }));
    setTileGrid(grid);
    // Sweep flip in a wave: diagonal order
    const order = grid
      .map((_, i) => i)
      .sort((a, b) => {
        const ax = a % 10, ay = Math.floor(a / 10);
        const bx = b % 10, by = Math.floor(b / 10);
        return (ax + ay) - (bx + by) || a - b;
      });
    // Make sure winner is LAST to flip
    const winnerIdx = winNum - 1;
    const noWinner = order.filter((i) => i !== winnerIdx);
    const sequence = [...noWinner, winnerIdx];
    let i = 0;
    const flipNext = () => {
      if (i >= sequence.length) {
        const t = setTimeout(() => {
          setRevealStep('settled');
          playThunk();
          setTimeout(() => (isRollover ? playSad() : playFanfare()), 200);
        }, 600);
        revealTimeoutsRef.current.push(t);
        return;
      }
      const target = sequence[i];
      setTileGrid((prev) => prev.map((tile, idx) => (idx === target ? { ...tile, flipped: true } : tile)));
      const remaining = sequence.length - i - 1;
      // Sound: subtle click during fast burn, deeper thuds on the dramatic last few,
      // and the winner flip is silent (the settle thunk + fanfare are the payoff).
      if (i === sequence.length - 1) {
        // winner flip — silence here, settle handles it
      } else if (remaining < 4) playTone(440 - (4 - remaining) * 60, 90, 0.20, 'sine');
      else playTick();
      i++;
      let delay: number;
      if (remaining === 0) delay = 0;
      else if (remaining === 1) delay = 1600;
      else if (remaining === 2) delay = 1100;
      else if (remaining === 3) delay = 800;
      else if (remaining === 4) delay = 550;
      else if (remaining === 5) delay = 350;
      else if (remaining === 6) delay = 200;
      else delay = 40;
      const t = setTimeout(flipNext, delay);
      revealTimeoutsRef.current.push(t);
    };
    const first = setTimeout(flipNext, 400);
    revealTimeoutsRef.current.push(first);
  };

  const startCurtainReveal = (_winNum: number, isRollover: boolean) => {
    setCurtainPhase('closed');
    const t1 = setTimeout(() => setCurtainPhase('shake'), 200);
    // Drum-roll: a series of low taps during the shake phase
    const drumTimers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < 12; i++) {
      drumTimers.push(setTimeout(() => playTone(120, 80, 0.25, 'square'), 300 + i * 180));
    }
    const t2 = setTimeout(() => { setCurtainPhase('opening'); playWhoosh(); }, 2400);
    const t3 = setTimeout(() => {
      setCurtainPhase('open');
      setRevealStep('settled');
      playThunk();
      setTimeout(() => (isRollover ? playSad() : playFanfare()), 250);
    }, 4400);
    revealTimeoutsRef.current.push(t1, t2, t3, ...drumTimers);
  };

  const startRevealSequence = (style: RevealStyle = 'scratch') => {
    if (!latestWin) return;
    cancelRevealAnimations();
    setRevealRun((r) => r + 1);
    setRevealStyle(style);
    setShowWinReveal(true);
    setRevealStep('running');
    setSlotNumber(1);
    setBingoGrid([]);
    setBingoFinale({ phase: 'idle', finalists: [], winnerIdx: -1, elimOrder: [] });
    setTileGrid([]);
    setCurtainPhase('closed');
    // Reset wheel rotation if it was previously animated
    const winNum = latestWin!.ballNumber;
    const isRollover = !!latestWin!.isRollover;
    if (style === 'slot') startSlotReveal(winNum, isRollover);
    else if (style === 'bingo') startBingoReveal(winNum, isRollover);
    else if (style === 'tile') startTileReveal(winNum, isRollover);
    else if (style === 'curtain') startCurtainReveal(winNum, isRollover);
  };

const fetchScheduled = async () => {
  const { data } = await supabase
    .from("scheduled_notifications")
    .select("*")
    .order("created_at", { ascending: false });
  if (data) setScheduledNotifications(data);
};
useEffect(() => {
  fetchScheduled();
}, []);
useEffect(() => {
  const fetchMembers = async () => {
    const { data } = await supabase
      .from("members")
      .select("id, email, full_name")
      .order("full_name");

    if (data) setMembers(data);
  };

  fetchMembers();
}, []);
useEffect(() => {
  if (!showLedger) return;

  supabase
    .from("bonus_ball_ledger")
    .select("*")
    .order("created_at", { ascending: false })
    .then(({ data, error }) => {
      if (error) {
        console.error("❌ Failed to load ledger", error);
      } else {
        setLedgerRows(data ?? []);
      }
    });
}, [showLedger]);
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
    if (event === "INITIAL_SESSION" && session && session.user) {
      loadBallsFromDb();
    }
    if (event === "SIGNED_IN" && session && session.user) {
      fetchBankBalance();
    }

    const recoveryFlag = Boolean((session?.user as any)?.recovery_sent_at);
    setIsRecoveryMode(recoveryFlag);
    setSessionEmail(session?.user.email ?? null);
  });

  return () => sub.subscription.unsubscribe();
}, []);
useEffect(() => {
  const loadOpenDraw = async () => {
    const { data, error } = await supabase
      .from("bonus_ball_winners")
      .select("id, draw_date, rollover_amount")
      .eq("status", "open")
      .single();
    if (error || !data) {
      console.error("❌ bonus_ball_winners fetch error", error);
      return;
    }

    setTotalRollover(data.rollover_amount ?? 0);

    // Never auto-advance an open draw on load. Once Saturday 8pm passes, the row sits
    // there showing this week's date until the admin records the winner — only THEN
    // does handleRecordResult set the next draw 7 days forward.
    //
    // Safety net: if the stored date is missing entirely OR more than 30 days in the
    // past (suggests a broken seed row, not just a slow admin), snap forward so the
    // app stays usable.
    const isStaleSeed = !data.draw_date || (() => {
      const [y, m, d] = String(data.draw_date).split('-').map(Number);
      const dt = new Date(y, m - 1, d, 20, 0, 0, 0);
      return (Date.now() - dt.getTime()) > 30 * 24 * 60 * 60 * 1000;
    })();
    if (isStaleSeed) {
      const corrected = computeUpcomingSaturday();
      const correctedIso = saturdayIso(corrected);
      const { error: updErr } = await supabase
        .from("bonus_ball_winners")
        .update({ draw_date: corrected, draw_timestamp: correctedIso })
        .eq("id", data.id);
      if (updErr) {
        console.error("❌ Failed to snap stale open draw", updErr);
      }
      setDrawDate(corrected);
    } else {
      setDrawDate(data.draw_date);
    }
  };
  loadOpenDraw();
}, []);
useEffect(() => {
  if (sessionEmail) {
    fetchBankBalance();
  }
}, [sessionEmail]);
useEffect(() => {
  const fetchWinners = () => {
    supabase
      .from("bonus_ball_winners")
      .select("*")
      .eq("status", "completed")
      .order("draw_date", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          console.error("❌ Failed to load winners", error);
          return;
        }
        setWinnerRows(data ?? []);
      });
  };
  fetchWinners();
  const channel = supabase
    .channel('winners-refresh')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bonus_ball_winners' }, fetchWinners)
    .subscribe();
  return () => {
    channel.unsubscribe();
  };
}, []);

const handleForgotPassword = async (e: React.FormEvent) => {
  e.preventDefault();

  const form = e.target as HTMLFormElement;
  const email = (form.elements.namedItem("email") as HTMLInputElement).value;

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });

  if (error) {
    showToast("error", error.message);
    return;
  }

  showToast("success", "Password reset email sent.");
  setAuthMode("login");
};

const handleResetPassword = async (e: React.FormEvent) => {
  e.preventDefault();

  const form = e.target as HTMLFormElement;
  const password = (form.elements.namedItem("password") as HTMLInputElement).value;

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    showToast("error", error.message);
    return;
  }

  showToast("success", "Password updated. You can now log in.");
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
    showToast("error", error.message);
    return;
  }
  setIsRecoveryMode(false);
  setNewPassword('');
  showToast("success", "Password updated.");
};


  // In-app notification banner — instant, local only. Caps at 50 to avoid unbounded growth.
  const addInAppNotification = (title: string, body: string, target: string, type: 'blast' | 'reminder' | 'win') => {
    const newNotif: NotificationMessage = {
      id: Math.random().toString(36).slice(2, 11),
      title, body,
      timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      type, target, read: false,
    };
    setNotifications((prev) => [newNotif, ...prev].slice(0, 50));
  };

  const dismissNotification = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };
  const clearAllNotifications = () => {
    if (!notifications.length) return;
    if (!confirm("Clear all notifications?")) return;
    setNotifications([]);
  };

  // Real web-push to subscribers. Returns true on success.
  const fireRealPush = async (title: string, body: string, target: string): Promise<boolean> => {
    try {
      const res = await fetch("/.netlify/functions/push-broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body, target }),
      });
      return res.ok;
    } catch (e) {
      console.error("Push broadcast failed", e);
      return false;
    }
  };

  // Used by event handlers (assign, payment, draw, etc). Always shows in-app banner; for
  // broadcast-style targets it also fires a real push so subscribers' phones get it.
  const sendPush = async (title: string, body: string, target: string, type: 'blast' | 'reminder' | 'win') => {
    addInAppNotification(title, body, target, type);
    if (target === "all" || target === "unpaid") {
      await fireRealPush(title, body, target);
    }
  };

  // CORE ACTIONS
  const commitAssignment = async () => {
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
    if (!bonusBallRowId) {
      console.log("🧪 assign aborted", { reason: "guard", selectedBall: adminAction?.ballNum, bonusBallRowId });
      return;
    }
    console.log("🧪 assign persisting");
    const selectedMember = members.find(
      (m) => m.id === selectedMemberId
    );
    const updatedBalls = balls.map(b => b.number === num ? {
      ...b,
      owner: assignmentName.trim(),
      userId: selectedMember ? selectedMember.id : null,
      email: selectedMember ? selectedMember.email : null,
    } : b);
    const { error } = await supabase
      .from("bonus_ball_data")
      .update({ state: { balls: updatedBalls } })
      .eq("id", bonusBallRowId);
    if (error) {
      console.error("❌ Failed to persist assignment", error);
      showToast("error", "Couldn't save that ball.");
      return;
    }
  setBalls(updatedBalls);
  console.log("✅ assign persisted");
  sendPush("Ball Assigned", `${assignmentName} has been assigned Ball #${num}`, "admin", "reminder");
  setAdminAction(null);
  setAssignmentName('');
  setSelectedMemberId('');
  setSelectedBallNum(null);
};

  const handleResetToVacant = async () => {
    if (!adminAction?.ballNum) return;

    const selectedBall = balls.find((b) => b.number === adminAction.ballNum);
    if (!selectedBall) return;

    const updatedBalls = balls.map((b) =>
      b.number === selectedBall.number
        ? {
            ...b,
            owner: null,
            ownerName: null,
            userId: null,
            email: null,
            paidUntil: null,
          }
        : b
    );

    if (!bonusBallRowId) {
      showToast("error", "Ball data not loaded yet.");
      return;
    }
    const { error } = await supabase
      .from("bonus_ball_data")
      .update({ state: { balls: updatedBalls } })
      .eq("id", bonusBallRowId)
      .select();
    if (error) {
      showToast("error", "Failed to clear ball.");
      return;
    }
    showToast("success", `Ball #${selectedBall.number} cleared.`);

    setBalls(updatedBalls);
    setShowAssignModal(false);
    setAdminAction(null);
  };

  const openEditModal = (ballNum: number) => {
    const ball = balls.find(b => b.number === ballNum);

    setAssignmentName(ball?.owner ?? '');
    setSelectedMemberId(ball?.userId ?? '');

    setAdminAction({ type: 'assign', ballNum });
  };

  const openAssignModal = (ballNum: number) => {
    setAssignmentName('');
    setSelectedMemberId('');
    setAdminAction({ type: 'assign', ballNum });
  };

  const commitPayment = async () => {
    if (!isAdmin) return;
    const num = payBall ?? adminAction?.ballNum;
    const weeks = parseInt(paymentWeeks);
    if (!num || isNaN(weeks) || weeks < 1) return;

    const selectedBall = balls.find(b => b.number === num);
    const targetOwner = applyToAllOwner ? selectedBall?.owner : null;
    const affectedNumbers = applyToAllOwner && targetOwner
      ? balls.filter(b => b.owner === targetOwner).map(b => b.number)
      : [num];

    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const updatedBalls = balls.map(ball => {
      if (!affectedNumbers.includes(ball.number)) return ball;
      if (!upcomingDrawDateTime) return ball;

      const existingPaidUntil = ball.paidUntil ? new Date(ball.paidUntil) : null;
      const alreadyCovered = existingPaidUntil && existingPaidUntil >= upcomingDrawDateTime;

      // If already covering the upcoming draw, the new payment adds full weeks on top of
      // existing paidUntil. If not covered, the first week pays for the upcoming draw
      // itself, so paidUntil = upcomingDraw + (weeks - 1).
      const newPaidUntilDate = alreadyCovered
        ? new Date(existingPaidUntil!.getTime() + weeks * weekMs)
        : new Date(upcomingDrawDateTime.getTime() + (weeks - 1) * weekMs);

      return {
        ...ball,
        paidUntil: newPaidUntilDate.toISOString(),
      };
    });

    if (!bonusBallRowId) return;

    console.log(`💾 Persisting payment for bonus_ball_data row ${bonusBallRowId}`);
    console.log(`💾 Persisting payment for ball ${num}`);
    const { error } = await supabase
      .from("bonus_ball_data")
      .update({ state: { balls: updatedBalls } })
      .eq("id", bonusBallRowId);
    if (error) {
      console.error("❌ Failed to persist payment", error);
      showToast("error", "Payment didn't save.");
      return;
    }
    setBalls(updatedBalls);
    console.log("✅ Payment persisted");
    const paymentAmount = weeks * 2 * affectedNumbers.length;
    const newBalance = await adjustBank(paymentAmount);
    if (newBalance !== null) {
      const { error: ledgerErr } = await supabase
        .from("bonus_ball_ledger")
        .insert([
          {
            type: "deposit",
            amount: paymentAmount,
            reference: "Ball payment",
            notes: `Payment for ${affectedNumbers.length} ball(s), ${weeks} week(s)`,
          },
        ]);
      if (ledgerErr) {
        console.error("❌ Failed to write ledger entry (deposit)", ledgerErr);
      }
      reloadLedger();
    }

    const ballsLabel = affectedNumbers.map((n) => `#${n}`).join(', ');
    const newPaidThrough = updatedBalls.find((b) => b.number === affectedNumbers[0])?.paidUntil;
    const throughLabel = newPaidThrough ? ` through ${formatPaidUntil(newPaidThrough)}` : '';
    showToast("success", `Ball${affectedNumbers.length > 1 ? 's' : ''} ${ballsLabel} paid${throughLabel} (£${paymentAmount}).`);
    sendPush("Payment Logged", `Ball${affectedNumbers.length > 1 ? 's' : ''} ${ballsLabel} paid${throughLabel}`, "admin", "reminder");
    setAdminAction(null);
    setPayBall(null);
    setPaymentWeeks('1');
    setApplyToAllOwner(false);
  };

  const handleUpdatePaymentInitiate = (ballNum: number) => {
    if (!isAdmin) return;
    setAdminAction({ type: 'payment', ballNum });
  };

  const hasUnread = notifications.some(n => !n.read);
  const selectedBall = balls.find(b => b.number === selectedBallNum);
  const isBallPaidForDraw = (ball: any) => {
    if (!ball?.paidUntil || !upcomingDrawDateTime) return false;
    const paidDate = new Date(ball.paidUntil);
    const normalized = new Date(paidDate);
    normalized.setHours(20, 0, 0, 0);
    return normalized >= upcomingDrawDateTime;
  };


  // ---------------------------------------------------------------------------
  // Redesign: view state + small helpers shared by the board and admin screens.
  // ---------------------------------------------------------------------------
  const [adminTab, setAdminTab] = useState<'week' | 'balls' | 'money' | 'messages' | 'settings'>('week');
  const [payBall, setPayBall] = useState<number | null>(null);
  const [notifyOnResult, setNotifyOnResult] = useState(true);
  const [recordBusy, setRecordBusy] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [ballFilter, setBallFilter] = useState<'all' | 'unpaid' | 'free'>('all');
  const [showAllWinners, setShowAllWinners] = useState(false);
  const [remindArmed, setRemindArmed] = useState(false);

  // The money tab needs the ledger to say whether the books balance.
  useEffect(() => {
    if (activeTab === 'admin' && isAdmin) reloadLedger();
  }, [activeTab, isAdmin]);

  const UI = {
    card: 'bg-white rounded-3xl p-4 sm:p-5',
    btn: 'rounded-xl px-4 py-2.5 text-sm font-extrabold bg-[#14161c] text-white active:scale-95 transition disabled:opacity-40',
    ghost: 'rounded-xl px-4 py-2.5 text-sm font-bold bg-[#e9ecf2] text-[#14161c] active:scale-95 transition disabled:opacity-40',
    input: 'w-full bg-white border border-[#dbe0e8] rounded-xl px-4 py-3 text-base text-[#14161c] outline-none focus:border-[#14161c]',
    dim: 'text-[#5a6270]',
    label: 'text-sm font-bold text-[#5a6270]',
  };
  const chip = (on: boolean) =>
    `rounded-full px-3.5 py-1.5 text-sm font-bold transition ${on ? 'bg-[#14161c] text-white' : 'bg-[#e9ecf2] text-[#5a6270]'}`;

  const shortDate = (d?: Date | string | null) => {
    if (!d) return '';
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  const drawDayLabel = (dateStr?: string | null) => {
    if (!dateStr) return '';
    const [y, m, d] = String(dateStr).split('-').map(Number);
    if (!y || !m || !d) return String(dateStr);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  // The top of the app takes the colour of the signed-in person's ball. White balls (1-9)
  // have no colour to give, so with several balls we use the first coloured one, and
  // fall back to the house blue when every ball is white.
  const me = (() => {
    const n = (myBalls.find((b) => b.number > 9) ?? myBalls[0])?.number;
    if (!n || n <= 9) return { bg: '#1f6fd0', fg: '#ffffff' };
    if (n <= 19) return { bg: '#005eb8', fg: '#ffffff' };
    if (n <= 29) return { bg: '#e4007f', fg: '#ffffff' };
    if (n <= 39) return { bg: '#009639', fg: '#ffffff' };
    if (n <= 49) return { bg: '#ffd100', fg: '#14161c' };
    return { bg: '#60269e', fg: '#ffffff' };
  })();

  const countdownText = (() => {
    if (!upcomingDrawDateTime) return '';
    const ms = upcomingDrawDateTime.getTime() - Date.now();
    if (ms <= 0) return 'Drawn. Waiting for the result to be entered.';
    const hours = Math.floor(ms / 3600000);
    const days = Math.floor(hours / 24);
    const when = `${shortDate(upcomingDrawDateTime)}, 8pm`;
    if (days >= 2) return `${when}. ${days} days to go`;
    if (days === 1) return `${when}. 1 day ${hours - 24} hrs to go`;
    if (hours >= 1) return `Tonight at 8pm. ${hours} hr${hours === 1 ? '' : 's'} to go`;
    return 'Tonight at 8pm. Under an hour to go';
  })();

  const ballStatus = (ball: any): 'free' | 'in' | 'out' =>
    !ball?.owner ? 'free' : isBallPaidForDraw(ball) ? 'in' : 'out';

  const renderBall = (num: number, status: 'free' | 'in' | 'out', cls: string) => {
    if (status === 'free') {
      return (
        <div className={`${cls} aspect-square rounded-full border-2 border-dotted border-[#9aa3b2] flex items-center justify-center text-[#5a6270] font-extrabold text-[0.7em]`}>
          {num}
        </div>
      );
    }
    return (
      <div className={`${cls} ${status === 'out' ? 'grayscale opacity-55' : ''}`}>
        <LotteryBall number={num} hideShadow className="w-full h-full" />
      </div>
    );
  };

  const openPay = (num: number) => {
    setPayBall(payBall === num ? null : num);
    setPaymentWeeks('1');
    setApplyToAllOwner(false);
  };

  // Mirrors commitPayment's date maths so the admin sees the outcome before saving.
  const payPreview = (ball: any) => {
    const weeks = Math.max(1, parseInt(paymentWeeks) || 1);
    const sameOwner = ball?.owner ? balls.filter((b) => b.owner === ball.owner) : [ball];
    const count = applyToAllOwner ? sameOwner.length : 1;
    let until: Date | null = null;
    if (upcomingDrawDateTime) {
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const existing = ball?.paidUntil ? new Date(ball.paidUntil) : null;
      const covered = existing && existing >= upcomingDrawDateTime;
      until = covered
        ? new Date(existing!.getTime() + weeks * weekMs)
        : new Date(upcomingDrawDateTime.getTime() + (weeks - 1) * weekMs);
    }
    return { weeks, count, cost: weeks * 2 * count, until, sameOwner };
  };

  const renderPayPanel = (ball: any) => {
    const p = payPreview(ball);
    return (
      <div className="bg-[#f1f3f7] rounded-2xl p-4 space-y-3 text-left">
        <div className="flex items-center gap-3">
          <button className={UI.ghost + ' bg-white'} aria-label="One week fewer" onClick={() => setPaymentWeeks(String(Math.max(1, p.weeks - 1)))}>−</button>
          <input
            type="number"
            min="1"
            inputMode="numeric"
            aria-label="Weeks paid"
            value={paymentWeeks}
            onChange={(e) => setPaymentWeeks(e.target.value)}
            className="w-20 text-center bg-white border border-[#dbe0e8] rounded-xl py-2.5 text-lg font-extrabold outline-none focus:border-[#14161c]"
          />
          <span className="flex-1 font-bold">week{p.weeks === 1 ? '' : 's'}</span>
          <button className={UI.ghost + ' bg-white'} aria-label="One week more" onClick={() => setPaymentWeeks(String(p.weeks + 1))}>+</button>
        </div>
        {p.sameOwner.length > 1 && (
          <label className="flex items-start gap-2.5 text-sm font-semibold">
            <input type="checkbox" className="mt-1 w-4 h-4 accent-[#14161c]" checked={applyToAllOwner} onChange={(e) => setApplyToAllOwner(e.target.checked)} />
            <span>Apply to all of {ball.owner}'s balls ({p.sameOwner.map((b) => b.number).join(', ')})</span>
          </label>
        )}
        <p className={`text-sm ${UI.dim}`}>
          <b className="text-[#14161c]">£{p.cost}</b> for {p.count} ball{p.count === 1 ? '' : 's'}.
          {p.until && <> In up to and including <b className="text-[#14161c]">{shortDate(p.until)}</b>.</>}
        </p>
        <button className={UI.btn + ' w-full py-3'} onClick={commitPayment}>Save payment</button>
      </div>
    );
  };

  const booksOk = Math.abs(bankBalance - expectedBankTotal) < 0.01 && Math.abs(bankBalance - ledgerNet) < 0.01;

  const resultOutcome = (() => {
    if (!selectedResultBall) return null;
    const ball = balls.find((b) => b.number === selectedResultBall);
    const status = ballStatus(ball);
    return { ball, status, num: selectedResultBall };
  })();

  const confirmResult = async () => {
    if (!selectedResultBall || recordBusy) return;
    setRecordBusy(true);
    try {
      await handleRecordResult();
    } finally {
      setRecordBusy(false);
    }
  };

  const remindUnpaid = async () => {
    if (!remindArmed) {
      setRemindArmed(true);
      setTimeout(() => setRemindArmed(false), 5000);
      return;
    }
    setRemindArmed(false);
    const ok = await fireRealPush('Bonus Ball', "Your ball isn't paid for Saturday's draw yet. Pay Carl to be in.", 'unpaid');
    showToast(ok ? 'success' : 'error', ok ? 'Reminder sent to everyone not paid.' : 'Reminder failed to send.');
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSessionEmail(null);
    setUserEmail('');
    setShowAccount(false);
    setActiveTab('home');
  };

  const enableNotifications = async () => {
    try {
      if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
        showToast('error', 'On iPhone, add the app to your Home Screen first, then try again.');
        return;
      }
      if (!VAPID_PUBLIC_KEY) {
        showToast('error', "Notifications aren't set up on the site yet. Carl needs to add the key in Netlify.");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        showToast('error', 'Notifications are blocked for this site.');
        return;
      }
      // iPhones only accept the key as bytes, so decode the base64url string first.
      const b64 = (VAPID_PUBLIC_KEY + '='.repeat((4 - (VAPID_PUBLIC_KEY.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
      const keyBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
      const { data: { user }, error: userErr } = await supabase.auth.getUser();
      if (userErr || !user) {
        showToast('error', 'Not logged in.');
        return;
      }
      const json = sub.toJSON();
      const endpoint = json.endpoint;
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (!endpoint || !p256dh || !auth) {
        showToast('error', 'Subscription missing required fields.');
        return;
      }
      const { error: upsertErr } = await supabase.from('push_subscriptions').upsert(
        { user_id: user.id, endpoint, p256dh, auth, active: true, created_at: new Date().toISOString() },
        { onConflict: 'endpoint' }
      );
      if (upsertErr) {
        showToast('error', upsertErr.message);
        return;
      }
      showToast('success', "You're set. You'll get a notification when the ball is in.");
    } catch (err: any) {
      showToast('error', err?.message ?? 'Could not turn notifications on.');
    }
  };

  const copyUserId = async () => {
    const { data } = await supabase.auth.getUser();
    const id = data.user?.id;
    if (!id) {
      showToast('error', 'Not logged in.');
      return;
    }
    await navigator.clipboard.writeText(id);
    showToast('success', 'User ID copied.');
  };

  const sendTestPush = async () => {
    const res = await fetch('/.netlify/functions/push-broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Test Push', body: 'Hello from Bonus Ball' }),
    });
    const text = await res.text();
    showToast(res.ok ? 'success' : 'error', text);
  };

  const sendBroadcast = async () => {
    const title = 'Announcement';
    const body = blastMessage;
    if (!body) return;

    if (scheduleMode === 'once') {
      if (!scheduleOnceDate || !scheduleOnceTime) {
        showToast('error', 'Pick a date and time.');
        return;
      }
      const sendAt = new Date(`${scheduleOnceDate}T${scheduleOnceTime}`);
      if (isNaN(sendAt.getTime()) || sendAt <= new Date()) {
        showToast('error', 'The time must be in the future.');
        return;
      }
      setIsTransmitting(true);
      try {
        const { error: insErr } = await supabase.from('scheduled_notifications').insert({
          title, body, target: blastTarget, delivery_mode: deliveryMode,
          send_at: sendAt.toISOString(), repeat_rule: null, active: true,
        });
        if (insErr) { showToast('error', 'Failed to schedule: ' + insErr.message); return; }
        await fetchScheduled();
        setBlastMessage('');
        showToast('success', 'Message scheduled.');
      } finally { setIsTransmitting(false); }
      return;
    }

    if (scheduleMode === 'recurring') {
      if (!recurringDay || !recurringTime) {
        showToast('error', 'Pick a day and time.');
        return;
      }
      const dayIndexMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const targetDay = dayIndexMap[recurringDay] ?? 6;
      const [hour, minute] = recurringTime.split(':').map(Number);
      const next = new Date();
      next.setHours(hour ?? 0, minute ?? 0, 0, 0);
      let diff = targetDay - next.getDay();
      if (diff < 0 || (diff === 0 && next <= new Date())) diff += 7;
      next.setDate(next.getDate() + diff);
      setIsTransmitting(true);
      try {
        const { error: insErr } = await supabase.from('scheduled_notifications').insert({
          title, body, target: blastTarget, delivery_mode: deliveryMode,
          send_at: next.toISOString(), repeat_rule: `weekly:${recurringDay}:${recurringTime}`, active: true,
        });
        if (insErr) { showToast('error', 'Failed to schedule: ' + insErr.message); return; }
        await fetchScheduled();
        setBlastMessage('');
        showToast('success', 'Weekly message saved.');
      } finally { setIsTransmitting(false); }
      return;
    }

    setIsTransmitting(true);
    try {
      if (deliveryMode === 'push') {
        const ok = await fireRealPush(title, body, blastTarget);
        showToast(ok ? 'success' : 'error', ok ? 'Message sent.' : 'Message failed to send.');
      } else {
        addInAppNotification(title, body, blastTarget, 'blast');
        showToast('success', 'Added to the in-app inbox.');
      }
      setBlastMessage('');
    } finally { setIsTransmitting(false); }
  };

  return (
    <div className="relative min-h-screen bg-[#f1f3f7] text-[#14161c]">
      {/* TOAST */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] w-max max-w-[90vw] sm:max-w-md flex items-center gap-3 bg-[#14161c] text-white rounded-2xl px-5 py-3 shadow-2xl">
          <span className={`text-xl leading-none ${toast.kind === 'error' ? 'text-red-400' : toast.kind === 'success' ? 'text-green-400' : 'text-sky-300'}`}>●</span>
          <span className="text-sm font-semibold">{toast.message}</span>
        </div>
      )}

      {/* SCRATCH REVEAL — the default */}
      {showWinReveal && revealStyle === 'scratch' && latestWin && (
        <ScratchReveal
          key={`${latestWin.id}-${revealRun}`}
          ballNumber={latestWin.ballNumber}
          winner={latestWin.winner}
          prize={latestWin.prizeAmount}
          isRollover={latestWin.isRollover}
          rolloverAmount={latestWin.rolloverAmount}
          drawDate={String(latestWin.date)}
          myNumbers={myBalls.map((b) => b.number)}
          bg={me.bg}
          fg={me.fg}
          muted={muted}
          onToggleMute={toggleMuted}
          onScratchSound={playTick}
          onRevealed={() => {
            setRevealStep('settled');
            playThunk();
            setTimeout(() => (latestWin.isRollover ? playChime(659, 500) : playFanfare()), 2300);
          }}
          onClose={(revealed) => {
            if (revealed) dismissReveal();
            else { cancelRevealAnimations(); setShowWinReveal(false); }
          }}
        />
      )}

      {/* CLASSIC REVEALS — still available from Admin, Settings */}
      {showWinReveal && revealStyle !== 'scratch' && (
        <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center bg-black overflow-hidden">

          {/* SLOT MACHINE — single big number cycling */}
          {revealStyle === 'slot' && (
            <div className="absolute inset-0 flex items-center justify-center px-4">
              <div className="relative flex flex-col items-center max-w-full">
                <p className={`text-[10px] md:text-[11px] font-black uppercase tracking-[0.5em] mb-6 md:mb-8 transition-colors ${revealStep === 'settled' ? 'text-yellow-400' : 'text-pink-500 animate-pulse'}`}>
                  {revealStep === 'settled' ? '★ LOCKED IN ★' : 'Drawing'}
                </p>
                {/* Wrapper sized to the ball so rays scale relative to it (not the whole screen) */}
                <div
                  className={`relative transition-transform duration-700 ease-out ${revealStep === 'settled' ? 'scale-110 md:scale-[1.3] drop-shadow-[0_0_120px_rgba(250,204,21,0.7)]' : 'scale-100'}`}
                  style={{ width: 'min(58vmin, 380px)', height: 'min(58vmin, 380px)' }}
                >
                  {/* Radiating rays sit behind the ball at 120% of its size */}
                  {revealStep === 'settled' && (
                    <div className="absolute -inset-[10%] rounded-full animate-slot-rays pointer-events-none" style={{ background: 'conic-gradient(from 0deg, transparent 0deg, rgba(250,204,21,0.25) 10deg, transparent 30deg, transparent 60deg, rgba(250,204,21,0.25) 70deg, transparent 90deg, transparent 120deg, rgba(250,204,21,0.25) 130deg, transparent 150deg, transparent 180deg, rgba(250,204,21,0.25) 190deg, transparent 210deg, transparent 240deg, rgba(250,204,21,0.25) 250deg, transparent 270deg, transparent 300deg, rgba(250,204,21,0.25) 310deg, transparent 330deg, transparent 360deg)' }} />
                  )}
                  <LotteryBall number={slotNumber} hideShadow={false} showNumber={true} className="w-full h-full" />
                </div>
              </div>
            </div>
          )}

          {/* BINGO ELIMINATION — phase 1: grid burn-down; phase 2: 3-ball finale showdown */}
          {revealStyle === 'bingo' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 md:p-8">
              {bingoFinale.phase === 'idle' ? (
                <>
                  <p className="text-[11px] font-black uppercase tracking-[0.5em] text-pink-500 mb-4 md:mb-6">Burning the Field</p>
                  <div className="grid grid-cols-8 gap-2 md:gap-3 w-full max-w-2xl px-2">
                    {bingoGrid.map((b) => (
                      <div
                        key={b.num}
                        className={`relative aspect-square flex items-center justify-center transition-all duration-500 ${
                          b.eliminated ? 'opacity-0 scale-0 rotate-180' : 'opacity-100 scale-100'
                        }`}
                        style={{ transitionTimingFunction: b.eliminated ? 'cubic-bezier(0.4, 0, 1, 1)' : 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                      >
                        <LotteryBall number={b.num} showNumber={true} className="w-full h-full" />
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {/* Big "FINAL 3" text that fades when we move to crowning */}
                  <p className={`font-black uppercase tracking-[0.4em] mb-6 md:mb-12 transition-all duration-500 ${bingoFinale.phase === 'crown' ? 'opacity-0 text-yellow-400 text-2xl' : bingoFinale.phase === 'rally' ? 'text-pink-500 text-2xl md:text-4xl animate-pulse scale-110' : 'text-pink-500 text-xl md:text-3xl'}`}>
                    {bingoFinale.phase === 'rally' ? '⚡ FINAL THREE ⚡' : bingoFinale.phase === 'shake3' ? 'Who Will It Be?' : bingoFinale.phase === 'elim1' || bingoFinale.phase === 'shake2' ? 'Down to Two…' : bingoFinale.phase === 'elim2' ? 'One Remains…' : ''}
                  </p>
                  <div className="flex items-center justify-center gap-3 sm:gap-6 md:gap-16 transition-all duration-700 px-4">
                    {bingoFinale.finalists.map((num, idx) => {
                      const isWinner = idx === bingoFinale.winnerIdx;
                      const phase = bingoFinale.phase;
                      const firstOut = bingoFinale.elimOrder[0];
                      const secondOut = bingoFinale.elimOrder[1];
                      const explodedOut = (idx === firstOut && (phase === 'elim1' || phase === 'shake2' || phase === 'elim2' || phase === 'crown'))
                        || (idx === secondOut && (phase === 'elim2' || phase === 'crown'));
                      const shaking =
                        (phase === 'shake3') ||
                        (phase === 'shake2' && idx !== firstOut);
                      const crowned = phase === 'crown' && isWinner;
                      const flashing =
                        (idx === firstOut && phase === 'elim1') ||
                        (idx === secondOut && phase === 'elim2');
                      return (
                        <div
                          key={`${num}-${idx}`}
                          className={`relative transition-all ease-out ${explodedOut ? 'duration-500 opacity-0 scale-0 rotate-[720deg]' : crowned ? 'duration-1000 scale-150 sm:scale-[1.7] md:scale-[1.8] drop-shadow-[0_0_80px_rgba(250,204,21,0.95)]' : 'duration-300 opacity-100 scale-100'} ${shaking ? 'animate-finalist-shake' : ''} ${flashing ? 'animate-finalist-flash' : ''}`}
                          style={{ width: 'min(26vw, 224px)', height: 'min(26vw, 224px)' }}
                        >
                          <LotteryBall number={num} showNumber={true} className="w-full h-full" />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* TILE FLIP — 59 face-down cards flip in sequence */}
          {revealStyle === 'tile' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 md:p-8">
              <p className="text-[11px] font-black uppercase tracking-[0.5em] text-pink-500 mb-4 md:mb-6">Turn Them Over</p>
              <div className="grid grid-cols-8 gap-2 md:gap-3 w-full max-w-2xl px-2">
                {tileGrid.map((tile) => {
                  const isWinner = tile.num === latestWin?.ballNumber;
                  const showFace = tile.flipped;
                  // Winner card grows dramatically once the reveal settles
                  const winnerSettled = isWinner && showFace && revealStep === 'settled';
                  return (
                    <div key={tile.num} className={`relative aspect-square transition-all duration-700 ease-out ${winnerSettled ? 'scale-[2.4] z-20 drop-shadow-[0_0_60px_rgba(250,204,21,0.9)]' : 'scale-100'}`} style={{ perspective: '800px' }}>
                      <div
                        className="absolute inset-0 transition-transform duration-500 ease-out"
                        style={{ transformStyle: 'preserve-3d', transform: showFace ? 'rotateY(180deg)' : 'rotateY(0)' }}
                      >
                        {/* back */}
                        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-gradient-to-br from-pink-500/20 to-pink-500/5 border border-pink-500/30 text-pink-400/80 font-black text-xl md:text-2xl" style={{ backfaceVisibility: 'hidden' }}>?</div>
                        {/* front — real lottery ball */}
                        <div
                          className={`absolute inset-0 flex items-center justify-center rounded-xl ${isWinner && showFace ? 'bg-yellow-400/20 ring-4 ring-yellow-400 shadow-[0_0_30px_rgba(250,204,21,0.8)]' : ''}`}
                          style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
                        >
                          <LotteryBall number={tile.num} showNumber={true} hideShadow={true} className="w-full h-full" />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* STAGE CURTAINS — drape opens, ball zooms in, confetti rains */}
          {revealStyle === 'curtain' && (
            <div className="absolute inset-0 overflow-hidden">
              {/* The revealed ball behind the curtains — zooms in dramatically when curtains open */}
              <div className={`absolute inset-0 flex items-center justify-center px-4 transition-all ease-out ${curtainPhase === 'open' ? 'opacity-100 scale-100 duration-1000' : 'opacity-0 scale-50 duration-300'}`}>
                <div style={{ width: 'min(65vmin, 28rem)', height: 'min(65vmin, 28rem)' }} className="flex items-center justify-center">
                  <LotteryBall
                    number={latestWin?.ballNumber ?? 1}
                    showNumber={true}
                    className="w-full h-full drop-shadow-[0_0_80px_rgba(250,204,21,0.8)]"
                  />
                </div>
              </div>
              {/* Confetti — 40 pieces falling with random colours and delays */}
              {curtainPhase === 'open' && (
                <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
                  {Array.from({ length: 40 }).map((_, i) => {
                    const colors = ['#ec4899', '#f97316', '#facc15', '#22c55e', '#06b6d4', '#a855f7', '#ffffff'];
                    const color = colors[i % colors.length];
                    const left = Math.random() * 100;
                    const delay = Math.random() * 0.6;
                    const duration = 2.5 + Math.random() * 1.5;
                    const drift = (Math.random() - 0.5) * 80;
                    const size = 8 + Math.random() * 10;
                    const shape = i % 2 === 0 ? '0' : '50%';
                    return (
                      <div
                        key={i}
                        className="absolute top-0 animate-confetti-fall"
                        style={{
                          left: `${left}%`,
                          width: `${size}px`,
                          height: `${size * 0.4}px`,
                          background: color,
                          borderRadius: shape,
                          animationDelay: `${delay}s`,
                          animationDuration: `${duration}s`,
                          ['--drift' as any]: `${drift}px`,
                        }}
                      />
                    );
                  })}
                </div>
              )}
              {/* Left curtain */}
              <div
                className={`absolute top-0 bottom-0 left-0 w-1/2 z-10 shadow-[0_0_60px_rgba(0,0,0,0.6)] transition-transform ${curtainPhase === 'opening' || curtainPhase === 'open' ? 'duration-[2000ms] -translate-x-full ease-in-out' : curtainPhase === 'shake' ? 'animate-curtain-shake-l' : ''}`}
                style={{ background: 'repeating-linear-gradient(90deg, #7f1d1d 0, #991b1b 16px, #7f1d1d 32px), linear-gradient(to right, #450a0a, #991b1b)' }}
              />
              {/* Right curtain */}
              <div
                className={`absolute top-0 bottom-0 right-0 w-1/2 z-10 shadow-[0_0_60px_rgba(0,0,0,0.6)] transition-transform ${curtainPhase === 'opening' || curtainPhase === 'open' ? 'duration-[2000ms] translate-x-full ease-in-out' : curtainPhase === 'shake' ? 'animate-curtain-shake-r' : ''}`}
                style={{ background: 'repeating-linear-gradient(90deg, #7f1d1d 0, #991b1b 16px, #7f1d1d 32px), linear-gradient(to left, #450a0a, #991b1b)' }}
              />
              {/* Building-tension label while closed */}
              {curtainPhase !== 'open' && (
                <p className="absolute bottom-[15vh] left-0 w-full text-center text-yellow-400 font-black uppercase tracking-[0.5em] text-xs md:text-sm animate-pulse z-20">And the winner is…</p>
              )}
            </div>
          )}

          {/* SHARED CONFETTI — fires for every style on settle (except curtain which has its own). */}
          {revealStep === 'settled' && revealStyle !== 'curtain' && (
            <div className="absolute inset-0 pointer-events-none z-30 overflow-hidden">
              {Array.from({ length: 50 }).map((_, i) => {
                const colors = ['#ec4899', '#f97316', '#facc15', '#22c55e', '#06b6d4', '#a855f7', '#ffffff'];
                const color = colors[i % colors.length];
                const left = Math.random() * 100;
                const delay = Math.random() * 0.8;
                const duration = 2.5 + Math.random() * 1.5;
                const drift = (Math.random() - 0.5) * 100;
                const size = 8 + Math.random() * 10;
                const shape = i % 2 === 0 ? '0' : '50%';
                return (
                  <div
                    key={i}
                    className="absolute top-0 animate-confetti-fall"
                    style={{
                      left: `${left}%`,
                      width: `${size}px`,
                      height: `${size * 0.4}px`,
                      background: color,
                      borderRadius: shape,
                      animationDelay: `${delay}s`,
                      animationDuration: `${duration}s`,
                      ['--drift' as any]: `${drift}px`,
                    }}
                  />
                );
              })}
            </div>
          )}

          {/* MUTE TOGGLE — top-right of modal, always visible */}
          <button
            onClick={toggleMuted}
            aria-label={muted ? 'Unmute' : 'Mute'}
            className="absolute top-4 right-4 z-[60] w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white/70 hover:text-white transition-all"
          >
            {muted ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 14l4-4m0 4l-4-4" /></svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
            )}
          </button>

          {/* SHARED NAMEPLATE — branches on rollover vs paid winner */}
          <div className={`absolute bottom-[6vh] left-0 w-full text-center transition-all duration-700 delay-300 pointer-events-auto z-[50] ${revealStep === 'settled' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
            {latestWin?.isRollover ? (
              <>
                <p className="text-orange-400 font-black uppercase tracking-[0.5em] text-xs md:text-sm mb-2 animate-pulse">🔥 Rollover Active 🔥</p>
                <p className="text-pink-500 font-black uppercase tracking-[0.5em] text-[10px] mb-3">Saturday Draw</p>
                <h2 className="text-4xl md:text-6xl font-black text-white tracking-tighter uppercase leading-none mb-2 drop-shadow-2xl">No Paid Winner</h2>
                <p className="text-orange-400 font-black text-lg md:text-2xl tracking-tighter">£{latestWin?.rolloverAmount || 0} rolls into next week</p>
                <div className="mt-6">
                  <button onClick={dismissReveal} className="px-10 py-4 bg-white text-black font-black uppercase text-[10px] tracking-[0.2em] rounded-full hover:bg-pink-500 hover:text-white transition-all shadow-2xl active:scale-95">Open Dashboard</button>
                </div>
              </>
            ) : (
              <>
                <p className="text-yellow-400 font-black uppercase tracking-[0.5em] text-xs md:text-sm mb-2 animate-pulse">🎉 Congratulations 🎉</p>
                <p className="text-pink-500 font-black uppercase tracking-[0.5em] text-[10px] mb-3">Saturday Draw Winner</p>
                <h2 className="text-4xl md:text-7xl font-black text-white tracking-tighter uppercase leading-none mb-2 drop-shadow-2xl">{latestWin?.winner}</h2>
                <p className="text-yellow-400 font-black text-2xl md:text-5xl tracking-tighter drop-shadow-xl">£{latestWin?.prizeAmount || 0}</p>
                <div className="mt-6">
                  <button onClick={dismissReveal} className="px-10 py-4 bg-white text-black font-black uppercase text-[10px] tracking-[0.2em] rounded-full hover:bg-pink-500 hover:text-white transition-all shadow-2xl active:scale-95">Open Dashboard</button>
                </div>
              </>
            )}
          </div>

          <style dangerouslySetInnerHTML={{ __html: `
            @keyframes curtainShakeL { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-3px); } 50% { transform: translateX(2px); } 75% { transform: translateX(-2px); } }
            @keyframes curtainShakeR { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(3px); } 50% { transform: translateX(-2px); } 75% { transform: translateX(2px); } }
            .animate-curtain-shake-l { animation: curtainShakeL 0.15s ease-in-out infinite; }
            .animate-curtain-shake-r { animation: curtainShakeR 0.15s ease-in-out infinite; }
            @keyframes confettiFall {
              0%   { transform: translate3d(0, -10vh, 0) rotate(0deg); opacity: 1; }
              100% { transform: translate3d(var(--drift, 0px), 110vh, 0) rotate(720deg); opacity: 0.8; }
            }
            .animate-confetti-fall { animation: confettiFall linear forwards; }
            @keyframes finalistShake {
              0%, 100% { transform: translateX(0) translateY(0) rotate(0); }
              10%      { transform: translateX(-6px) translateY(-2px) rotate(-3deg); }
              25%      { transform: translateX(7px) translateY(2px) rotate(3deg); }
              40%      { transform: translateX(-5px) translateY(0) rotate(-2deg); }
              55%      { transform: translateX(6px) translateY(-3px) rotate(2deg); }
              70%      { transform: translateX(-4px) translateY(2px) rotate(-2deg); }
              85%      { transform: translateX(3px) translateY(0) rotate(1deg); }
            }
            .animate-finalist-shake { animation: finalistShake 0.4s ease-in-out infinite; }
            @keyframes finalistFlash {
              0%, 100% { filter: drop-shadow(0 0 0 rgba(239,68,68,0)); }
              50%      { filter: drop-shadow(0 0 50px rgba(239,68,68,0.95)); transform: scale(1.15); }
            }
            .animate-finalist-flash { animation: finalistFlash 0.3s ease-in-out infinite; }
            @keyframes slotRays {
              from { transform: rotate(0deg); }
              to   { transform: rotate(360deg); }
            }
            .animate-slot-rays { animation: slotRays 6s linear infinite; }
          ` }} />
        </div>
      )}

      {isLoggedIn ? (
        <>
          {activeTab === 'admin' && isAdmin ? (
            /* ============================ ADMIN ============================ */
            <div className="max-w-lg mx-auto min-h-screen pb-16">
              <div className="sticky top-0 z-40 bg-[#f1f3f7]/95 backdrop-blur px-4 pt-4">
                <div className="flex items-center justify-between">
                  <button onClick={() => setActiveTab('home')} className={UI.ghost + ' bg-white'}>‹ Board</button>
                  <h1 className="text-xl font-extrabold tracking-tight">Admin</h1>
                  <span className="w-[5.5rem]" />
                </div>
                <div className="flex gap-1 overflow-x-auto mt-3 border-b border-[#dbe0e8]" role="tablist">
                  {([['week', 'This week'], ['balls', 'Balls'], ['money', 'Money'], ['messages', 'Messages'], ['settings', 'Settings']] as const).map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={adminTab === key}
                      onClick={() => { setAdminTab(key); setPayBall(null); }}
                      className={`flex-1 whitespace-nowrap px-1.5 py-2.5 text-[13px] font-extrabold border-b-[3px] -mb-px ${adminTab === key ? 'border-[#14161c] text-[#14161c]' : 'border-transparent text-[#5a6270]'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="px-4 pt-4 space-y-3">
                {/* ---------- THIS WEEK ---------- */}
                {adminTab === 'week' && (
                  <>
                    <div className="grid grid-cols-3 gap-px bg-[#dbe0e8] rounded-2xl overflow-hidden">
                      <div className="bg-white p-3"><p className="text-xl font-extrabold tabular-nums">£{currentPot}</p><p className={`text-xs font-semibold ${UI.dim}`}>Pot</p></div>
                      <div className="bg-white p-3"><p className="text-xl font-extrabold tabular-nums">{paidCount}/59</p><p className={`text-xs font-semibold ${UI.dim}`}>Paid in</p></div>
                      <button className="bg-white p-3 text-left" onClick={() => setAdminTab('money')}>
                        <p className="text-xl font-extrabold tabular-nums">£{bankBalance}</p>
                        <p className={`text-xs font-bold ${booksOk ? 'text-green-700' : 'text-red-600'}`}>{booksOk ? 'Bank ✓' : 'Bank: check'}</p>
                      </button>
                    </div>

                    <div className={UI.card + ' space-y-3'}>
                      <h3 className="font-extrabold flex items-center gap-2">
                        <span className={`w-6 h-6 rounded-full text-xs flex items-center justify-center ${ballsDueThisWeek.length === 0 ? 'bg-green-600 text-white' : 'bg-[#e9ecf2]'}`}>{ballsDueThisWeek.length === 0 ? '✓' : '1'}</span>
                        {ballsDueThisWeek.length === 0
                          ? 'Everyone who owns a ball is paid'
                          : `Chase ${ballsDueThisWeek.length} unpaid ball${ballsDueThisWeek.length === 1 ? '' : 's'}`}
                      </h3>
                      {ballsDueThisWeek.map((b) => (
                        <div key={b.number} className="space-y-2">
                          <div className="flex items-center gap-3">
                            {renderBall(b.number, 'out', 'w-10 h-10 flex-none')}
                            <div className="flex-1 min-w-0">
                              <p className="font-bold truncate">{b.owner}</p>
                              <p className={`text-xs ${UI.dim}`}>{b.paidUntil ? `Ran out ${shortDate(b.paidUntil)}` : 'Never paid'}</p>
                            </div>
                            <button className={payBall === b.number ? UI.ghost : UI.btn} onClick={() => openPay(b.number)}>{payBall === b.number ? 'Close' : 'Paid'}</button>
                          </div>
                          {payBall === b.number && renderPayPanel(b)}
                        </div>
                      ))}
                      {ballsDueThisWeek.length > 0 && (
                        <button className={UI.ghost + ' w-full py-3'} onClick={remindUnpaid}>
                          {remindArmed ? 'Tap again to send the reminder' : 'Remind everyone not paid'}
                        </button>
                      )}
                    </div>

                    <div className={UI.card + ' space-y-3'}>
                      <h3 className="font-extrabold flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full text-xs flex items-center justify-center bg-[#e9ecf2]">2</span>
                        Enter the bonus ball for {drawDayLabel(drawDate)}
                      </h3>
                      {!drawAwaitingResult && (
                        <p className="text-sm font-semibold text-amber-700 bg-amber-50 rounded-xl px-3 py-2">This draw hasn't happened yet. It's on {shortDate(upcomingDrawDateTime)} at 8pm.</p>
                      )}
                      <div className="grid grid-cols-10 gap-1">
                        {balls.map((b) => (
                          <button
                            key={b.number}
                            aria-label={`Ball ${b.number}`}
                            aria-pressed={selectedResultBall === b.number}
                            onClick={() => setSelectedResultBall(selectedResultBall === b.number ? null : b.number)}
                            className={`rounded-full ${selectedResultBall === b.number ? 'ring-4 ring-[#f2b632] scale-110' : ''} transition`}
                          >
                            <LotteryBall number={b.number} hideShadow className="w-full" />
                          </button>
                        ))}
                      </div>
                      <div className="bg-[#f1f3f7] rounded-2xl p-3 text-sm">
                        {!resultOutcome ? (
                          <span className={UI.dim}>Tap the number that came up. You'll see what happens before anything is saved.</span>
                        ) : resultOutcome.status === 'in' ? (
                          <><b className="text-base">{resultOutcome.ball.owner} wins £{currentPot}.</b><br />Ball {resultOutcome.num} is paid for this draw.</>
                        ) : resultOutcome.status === 'out' ? (
                          <><b className="text-base">Ball {resultOutcome.num} is {resultOutcome.ball.owner}'s, but it isn't paid.</b><br />Nobody wins. £{currentPot} rolls over.</>
                        ) : (
                          <><b className="text-base">Ball {resultOutcome.num} has no owner.</b><br />Nobody wins. £{currentPot} rolls over.</>
                        )}
                      </div>
                      <label className="flex items-start gap-2.5 text-sm font-semibold">
                        <input type="checkbox" className="mt-1 w-4 h-4 accent-[#14161c]" checked={notifyOnResult} onChange={(e) => setNotifyOnResult(e.target.checked)} />
                        <span>Send everyone "Saturday's ball is in" (doesn't give the number away)</span>
                      </label>
                      <div>
                        <label className={UI.label} htmlFor="reveal-style">Reveal</label>
                        <select id="reveal-style" className={UI.input + ' mt-1'} value={recordRevealStyle} onChange={(e) => setRecordRevealStyle(e.target.value as RevealStyle | '')}>
                          <option value="">Default ({REVEAL_STYLES.find((s) => s.value === revealDefaultStyle)?.label})</option>
                          {REVEAL_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                      </div>
                      <button className={UI.btn + ' w-full py-3.5'} disabled={!selectedResultBall || recordBusy} onClick={confirmResult}>
                        {recordBusy ? 'Saving…' : selectedResultBall ? `Confirm ball ${selectedResultBall}` : 'Confirm result'}
                      </button>
                    </div>
                  </>
                )}

                {/* ---------- BALLS ---------- */}
                {adminTab === 'balls' && (
                  <>
                    <input type="text" placeholder="Search name or number" className={UI.input} value={adminSearchTerm} onChange={(e) => setAdminSearchTerm(e.target.value)} />
                    <div className="flex gap-2 flex-wrap">
                      <button className={chip(ballFilter === 'all')} onClick={() => setBallFilter('all')}>All 59</button>
                      <button className={chip(ballFilter === 'unpaid')} onClick={() => setBallFilter('unpaid')}>Not paid {ballsDueThisWeek.length}</button>
                      <button className={chip(ballFilter === 'free')} onClick={() => setBallFilter('free')}>Free {balls.filter((b) => !b.owner).length}</button>
                    </div>
                    <div className={UI.card + ' divide-y divide-[#e9ecf2]'}>
                      {balls.map((ball) => {
                        const status = ballStatus(ball);
                        const term = adminSearchTerm.trim().toLowerCase();
                        if (term && !(String(ball.number).includes(term) || (ball.owner ?? '').toLowerCase().includes(term))) return null;
                        if (ballFilter === 'unpaid' && status !== 'out') return null;
                        if (ballFilter === 'free' && status !== 'free') return null;
                        return (
                          <div key={ball.number} className="py-3 first:pt-0 last:pb-0 space-y-2">
                            <div className="flex items-center gap-3">
                              {renderBall(ball.number, status, 'w-10 h-10 flex-none')}
                              <div className="flex-1 min-w-0">
                                <p className="font-bold truncate">{ball.owner ?? 'Free'}</p>
                                <p className={`text-xs ${UI.dim}`}>
                                  {status === 'free' ? 'Nobody has this ball' : status === 'in' ? `Paid up to ${shortDate(ball.paidUntil)}` : ball.paidUntil ? `Ran out ${shortDate(ball.paidUntil)}` : 'Never paid'}
                                </p>
                              </div>
                              {ball.owner ? (
                                <>
                                  <button className={(payBall === ball.number || status === 'in' ? UI.ghost : UI.btn) + ' px-3'} onClick={() => openPay(ball.number)}>{payBall === ball.number ? 'Close' : 'Paid'}</button>
                                  <button className={UI.ghost + ' px-3'} onClick={() => openEditModal(ball.number)}>Edit</button>
                                </>
                              ) : (
                                <button className={UI.ghost + ' px-3'} onClick={() => openAssignModal(ball.number)}>Assign</button>
                              )}
                            </div>
                            {payBall === ball.number && renderPayPanel(ball)}
                          </div>
                        );
                      })}
                    </div>
                    <div className={UI.card + ' space-y-3'}>
                      <h3 className="font-extrabold">People with a login</h3>
                      {membersWithStats.length === 0 ? (
                        <p className={`text-sm ${UI.dim}`}>Nobody has registered yet.</p>
                      ) : membersWithStats.map((m: any) => (
                        <div key={m.id} className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="font-bold truncate">{m.full_name || 'No name'}</p>
                            <p className={`text-xs truncate ${UI.dim}`}>{m.email}</p>
                            <p className={`text-xs ${UI.dim}`}>{m.ballNumbers.length === 0 ? 'No balls linked' : `Ball${m.ballNumbers.length === 1 ? '' : 's'} ${m.ballNumbers.join(', ')}`}</p>
                          </div>
                          <button className="text-sm font-bold text-red-600 px-2 py-1" onClick={() => removeMember(m.id, m.full_name || m.email)}>Remove</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* ---------- MONEY ---------- */}
                {adminTab === 'money' && (
                  <>
                    <div className={UI.card}>
                      <p className={UI.label}>In the bank</p>
                      <p className="text-5xl font-extrabold tracking-tight tabular-nums">£{Number(bankBalance).toFixed(2)}</p>
                      <span className={`inline-block mt-2 rounded-full px-3 py-1 text-sm font-bold ${booksOk ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}`}>{booksOk ? 'Books balance' : "Books don't balance"}</span>
                      <dl className="mt-4 text-sm space-y-1.5">
                        <div className="flex justify-between"><dt className={UI.dim}>Prepaid weeks + rollover should be</dt><dd className={`font-bold tabular-nums ${Math.abs(bankBalance - expectedBankTotal) < 0.01 ? '' : 'text-red-600'}`}>£{Number(expectedBankTotal).toFixed(2)}</dd></div>
                        <div className="flex justify-between"><dt className={UI.dim}>Ledger adds up to</dt><dd className={`font-bold tabular-nums ${Math.abs(bankBalance - ledgerNet) < 0.01 ? '' : 'text-red-600'}`}>£{Number(ledgerNet).toFixed(2)}</dd></div>
                        <div className="flex justify-between"><dt className={UI.dim}>Rolled over into this pot</dt><dd className="font-bold tabular-nums">£{Number(totalRollover).toFixed(2)}</dd></div>
                      </dl>
                    </div>
                    <div className={UI.card + ' space-y-2'}>
                      <h3 className="font-extrabold">Add an entry</h3>
                      <select aria-label="Entry type" className={UI.input} value={newEntryType} onChange={(e) => setNewEntryType(e.target.value as any)}>
                        <option value="deposit">Money in</option>
                        <option value="paid_win">Prize paid out</option>
                        <option value="adjustment">Adjustment (can be negative)</option>
                      </select>
                      <div className="flex gap-2">
                        <input type="number" step="0.01" inputMode="decimal" placeholder="£" aria-label="Amount" className={UI.input + ' w-28 flex-none'} value={newEntryAmount} onChange={(e) => setNewEntryAmount(e.target.value)} />
                        <input type="text" placeholder="Note (optional)" aria-label="Note" className={UI.input} value={newEntryNotes} onChange={(e) => setNewEntryNotes(e.target.value)} />
                      </div>
                      <button className={UI.btn + ' w-full py-3'} disabled={ledgerBusy} onClick={addManualEntry}>Add entry</button>
                    </div>
                    <div className={UI.card + ' divide-y divide-[#e9ecf2]'}>
                      {ledgerWithRunning.length === 0 ? (
                        <p className={`text-sm ${UI.dim}`}>No ledger entries yet.</p>
                      ) : ledgerWithRunning.map((row) => {
                        const effect = ledgerEffectOnBank(row.type, row.amount);
                        const typeLabel: Record<string, string> = { deposit: 'Money in', paid_win: 'Prize paid', charity: 'Charity', adjustment: 'Adjustment' };
                        return (
                          <div key={row.id} className="py-3 first:pt-0 last:pb-0 flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="font-bold">{typeLabel[row.type] ?? row.type}</p>
                              <p className={`text-xs ${UI.dim}`}>{new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}{row.notes ? `, ${row.notes}` : row.reference ? `, ${row.reference}` : ''}</p>
                              <button className="text-xs font-bold text-red-600 mt-1" disabled={ledgerBusy} onClick={() => deleteLedgerEntry(row)}>Delete</button>
                            </div>
                            <div className="text-right">
                              <p className={`font-extrabold tabular-nums ${effect > 0 ? 'text-green-700' : effect < 0 ? 'text-red-600' : ''}`}>{effect > 0 ? '+' : effect < 0 ? '−' : ''}£{Math.abs(Number(row.amount)).toFixed(2)}</p>
                              <p className={`text-xs tabular-nums ${UI.dim}`}>£{Number(row.runningBalance).toFixed(2)}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {/* ---------- MESSAGES ---------- */}
                {adminTab === 'messages' && (
                  <>
                    <div className={UI.card + ' space-y-3'}>
                      <h3 className="font-extrabold">New message</h3>
                      <textarea aria-label="Message" rows={4} placeholder="What do you want to say?" className={UI.input + ' resize-none'} value={blastMessage} onChange={(e) => setBlastMessage(e.target.value)} />
                      <div>
                        <p className={UI.label + ' mb-1.5'}>To</p>
                        <div className="flex gap-2 flex-wrap">
                          <button className={chip(blastTarget === 'all')} onClick={() => setBlastTarget('all')}>Everyone</button>
                          <button className={chip(blastTarget === 'unpaid')} onClick={() => setBlastTarget('unpaid')}>Not paid</button>
                        </div>
                      </div>
                      <div>
                        <p className={UI.label + ' mb-1.5'}>How</p>
                        <div className="flex gap-2 flex-wrap">
                          <button className={chip(deliveryMode === 'push')} onClick={() => setDeliveryMode('push')}>Phone notification</button>
                          <button className={chip(deliveryMode === 'inapp')} onClick={() => setDeliveryMode('inapp')}>In-app inbox</button>
                        </div>
                      </div>
                      <div>
                        <p className={UI.label + ' mb-1.5'}>When</p>
                        <div className="flex gap-2 flex-wrap">
                          <button className={chip(scheduleMode === 'now')} onClick={() => setScheduleMode('now')}>Now</button>
                          <button className={chip(scheduleMode === 'once')} onClick={() => setScheduleMode('once')}>Later</button>
                          <button className={chip(scheduleMode === 'recurring')} onClick={() => setScheduleMode('recurring')}>Every week</button>
                        </div>
                      </div>
                      {scheduleMode === 'once' && (
                        <div className="grid grid-cols-2 gap-2">
                          <input type="date" aria-label="Date" className={UI.input} value={scheduleOnceDate} onChange={(e) => setScheduleOnceDate(e.target.value)} />
                          <input type="time" aria-label="Time" className={UI.input} value={scheduleOnceTime} onChange={(e) => setScheduleOnceTime(e.target.value)} />
                        </div>
                      )}
                      {scheduleMode === 'recurring' && (
                        <div className="grid grid-cols-2 gap-2">
                          <select aria-label="Day" className={UI.input} value={recurringDay} onChange={(e) => setRecurringDay(e.target.value)}>
                            {['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => <option key={d} value={d}>{d}</option>)}
                          </select>
                          <input type="time" aria-label="Time" className={UI.input} value={recurringTime} onChange={(e) => setRecurringTime(e.target.value)} />
                        </div>
                      )}
                      <button className={UI.btn + ' w-full py-3.5'} disabled={isTransmitting || !blastMessage} onClick={sendBroadcast}>
                        {isTransmitting ? 'Sending…' : scheduleMode === 'now' ? 'Send now' : 'Save schedule'}
                      </button>
                    </div>
                    <div className={UI.card + ' space-y-3'}>
                      <h3 className="font-extrabold">Scheduled</h3>
                      {scheduledNotifications.length === 0 && <p className={`text-sm ${UI.dim}`}>Nothing scheduled.</p>}
                      {(scheduledNotifications as any[]).map((item) => (
                        <div key={item.id} className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="font-bold">{item.body}</p>
                            <p className={`text-xs ${UI.dim}`}>
                              To {item.target === 'unpaid' ? 'not paid' : 'everyone'}
                              {item.repeat_rule ? `, every ${String(item.repeat_rule).split(':').slice(1).join(' at ')}` : item.send_at ? `, ${new Date(item.send_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                            </p>
                          </div>
                          <button className="text-sm font-bold text-red-600 px-2 py-1" onClick={() => deleteScheduled(item.id)}>Delete</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* ---------- SETTINGS ---------- */}
                {adminTab === 'settings' && (
                  <>
                    <div className={UI.card + ' space-y-3'}>
                      <h3 className="font-extrabold">Reveal style</h3>
                      {!latestWin && <p className={`text-sm ${UI.dim}`}>Record a draw first to preview these.</p>}
                      {([
                        { value: 'scratch', desc: 'Scratch the gold off the ball with your finger' },
                        { value: 'bingo', desc: 'All 59 balls knocked out down to a final three' },
                        { value: 'slot', desc: 'One big number spins and slows' },
                        { value: 'tile', desc: 'Tiles flip over, winner last' },
                        { value: 'curtain', desc: 'Red curtains shake, then part' },
                      ] as { value: RevealStyle; desc: string }[]).map((opt) => {
                        const isDefault = revealDefaultStyle === opt.value;
                        return (
                          <div key={opt.value} className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="font-bold">{REVEAL_STYLES.find((s) => s.value === opt.value)?.label}{isDefault && <span className="ml-2 text-xs font-bold bg-[#14161c] text-white rounded-full px-2 py-0.5">Default</span>}</p>
                              <p className={`text-xs ${UI.dim}`}>{opt.desc}</p>
                            </div>
                            <button className={UI.ghost + ' px-3'} disabled={!latestWin} onClick={() => startRevealSequence(opt.value)}>Preview</button>
                            {!isDefault && <button className={UI.ghost + ' px-3'} onClick={() => setAsDefaultStyle(opt.value)}>Use</button>}
                          </div>
                        );
                      })}
                    </div>
                    <div className={UI.card + ' flex items-center gap-3'}>
                      <div className="flex-1"><p className="font-bold">Send a test notification</p><p className={`text-xs ${UI.dim}`}>Goes to everyone with notifications on, not just you.</p></div>
                      <button className={UI.ghost} onClick={sendTestPush}>Send</button>
                    </div>
                    <div className={UI.card + ' flex items-center gap-3'}>
                      <div className="flex-1"><p className="font-bold">Copy my user ID</p><p className={`text-xs ${UI.dim}`}>For fixing account links.</p></div>
                      <button className={UI.ghost} onClick={copyUserId}>Copy</button>
                    </div>
                    <div className="bg-white rounded-3xl p-4 sm:p-5 border-2 border-red-200">
                      <button onClick={() => setDangerOpen((v) => !v)} className="w-full flex items-center justify-between text-left">
                        <div><p className="font-extrabold text-red-700">Hard reset</p><p className={`text-xs ${UI.dim}`}>Clears every ball and winner, and sets the bank to £0.</p></div>
                        <span className={UI.dim}>{dangerOpen ? '▾' : '▸'}</span>
                      </button>
                      {dangerOpen && (
                        <div className="mt-4 space-y-2">
                          <p className="text-sm text-red-700">This cannot be undone. Past ledger entries stay.</p>
                          <input type="password" aria-label="PIN" placeholder="Enter PIN" className={UI.input} value={resetPin} onChange={(e) => setResetPin(e.target.value)} />
                          <button disabled={isResetting} onClick={handleHardReset} className="w-full py-3 rounded-xl bg-red-600 text-white font-extrabold disabled:opacity-50">{isResetting ? 'Resetting…' : 'Hard reset'}</button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            /* ============================ THE BOARD ============================ */
            <div className="max-w-lg mx-auto pb-12">
              <header className="rounded-b-[2rem] px-5 pt-5 pb-7" style={{ background: me.bg, color: me.fg }}>
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-lg font-extrabold tracking-tight">Bonus Ball</p>
                  <button
                    aria-label="Notifications"
                    onClick={() => { setShowInbox(true); setNotifications((prev) => prev.map((n) => ({ ...n, read: true }))); }}
                    className="relative w-10 h-10 rounded-full bg-black/15 flex items-center justify-center"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                    {hasUnread && <span className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-[#ffd100] border border-black/20" />}
                  </button>
                  <button aria-label="Account" onClick={() => setShowAccount(true)} className="w-10 h-10 rounded-full bg-black/15 font-extrabold uppercase">
                    {(sessionEmail ?? '?').charAt(0)}
                  </button>
                </div>

                {latestWin && !hasSeenLatestReveal ? (
                  <div className="mt-6">
                    <p className="text-4xl font-extrabold tracking-tight leading-tight">Saturday's ball is in</p>
                    <p className="font-semibold opacity-90 mt-1">Scratch it off to see if it's yours.</p>
                    <button onClick={() => startRevealSequence(latestWin.revealStyle)} className="mt-4 rounded-2xl bg-white text-[#14161c] font-extrabold px-6 py-3.5 active:scale-95 transition">Show me</button>
                  </div>
                ) : (
                  <div className="mt-5">
                    <p className="font-bold opacity-90">Saturday's pot</p>
                    <p className="text-[5.5rem] font-extrabold leading-none tracking-tighter tabular-nums">£{currentPot}</p>
                    <p className="font-semibold mt-2">{countdownText}</p>
                    {totalRollover > 0 && (
                      <span className="inline-block mt-3 rounded-full bg-[#ffd100] text-[#14161c] text-sm font-extrabold px-3 py-1 ring-1 ring-black/10">
                        {rolloverStreak >= 2 ? `Rolled over ${rolloverStreak} times. ` : ''}Includes £{totalRollover} rolled over
                      </span>
                    )}
                  </div>
                )}
              </header>

              <main className="px-4 pt-4 space-y-3">
                {/* YOUR BALLS */}
                <section className={UI.card + ' space-y-3'}>
                  <h2 className="font-extrabold">Your balls</h2>
                  {myBalls.length === 0 ? (
                    <p className={`text-sm ${UI.dim}`}>You don't have a ball yet. The dotted ones below are free. Ask Carl for one.</p>
                  ) : myBalls.map((b) => {
                    const weeks = weeksCoveredFor(b);
                    return (
                      <button key={b.number} onClick={() => setSelectedBallNum(b.number)} className="w-full flex items-center gap-3 text-left">
                        {renderBall(b.number, weeks > 0 ? 'in' : 'out', 'w-14 h-14 flex-none')}
                        <div className="flex-1 min-w-0">
                          <p className="font-bold">{weeks > 0 ? 'In for Saturday' : 'Not in this Saturday'}</p>
                          <p className={`text-sm ${UI.dim}`}>{weeks > 0 ? `Paid up to ${shortDate(b.paidUntil)} (${weeks} draw${weeks === 1 ? '' : 's'})` : 'Pay Carl to get it back in. If it comes up unpaid, the pot rolls over.'}</p>
                        </div>
                        {weeks > 0 && <span className="rounded-full bg-green-100 text-green-800 text-xs font-extrabold px-2.5 py-1">Paid</span>}
                      </button>
                    );
                  })}
                </section>

                {/* LAST DRAW — hidden until they've seen the reveal */}
                {latestWin && hasSeenLatestReveal && (
                  <section className={UI.card + ' flex items-center gap-3'}>
                    <LotteryBall number={latestWin.ballNumber} hideShadow className="w-14 h-14 flex-none" />
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${UI.dim}`}>Last draw, {drawDayLabel(latestWin.date)}</p>
                      <p className="font-extrabold leading-snug">{latestWin.isRollover ? `Rolled over (£${latestWin.rolloverAmount})` : `${latestWin.winner} won £${latestWin.prizeAmount}`}</p>
                    </div>
                    <button className={UI.ghost} onClick={() => startRevealSequence(revealDefaultStyle)}>Replay</button>
                  </section>
                )}

                {/* THE BOARD */}
                <section className={UI.card + ' space-y-3'}>
                  <div className="flex items-baseline justify-between">
                    <h2 className="font-extrabold">The board</h2>
                    <span className={`text-sm font-semibold ${UI.dim}`}>{paidCount} of 59 in</span>
                  </div>
                  <div className="grid grid-cols-8 gap-1.5 text-sm">
                    {balls.map((ball) => {
                      const mine = myBalls.some((b) => b.number === ball.number);
                      return (
                        <button
                          key={ball.number}
                          aria-label={`Ball ${ball.number}, ${ball.owner ?? 'free'}`}
                          onClick={() => setSelectedBallNum(ball.number)}
                          className={`rounded-full active:scale-90 transition ${mine ? 'ring-[3px] ring-[#14161c] ring-offset-2' : ''}`}
                        >
                          {renderBall(ball.number, ballStatus(ball), 'w-full')}
                        </button>
                      );
                    })}
                  </div>
                  <p className={`text-xs ${UI.dim}`}>Colour means in. Grey means not paid. Dotted means free. Tap any ball to see whose it is.</p>
                </section>

                {/* WINNERS */}
                <section className={UI.card + ' space-y-3'}>
                  <h2 className="font-extrabold">Winners</h2>
                  {(() => {
                    const rows = (winnerRows as any[]).filter((r) => hasSeenLatestReveal || r.id !== (latestWin as any)?.id);
                    if (rows.length === 0) return <p className={`text-sm ${UI.dim}`}>No draws yet.</p>;
                    return (
                      <>
                        {rows.slice(0, showAllWinners ? rows.length : 5).map((r) => (
                          <div key={r.id} className="flex items-center gap-3">
                            <LotteryBall number={Number(r.winning_number)} hideShadow className="w-10 h-10 flex-none" />
                            <div className="flex-1 min-w-0">
                              <p className="font-bold truncate">{r.winner_name ?? 'Rolled over'}</p>
                              <p className={`text-xs ${UI.dim}`}>{drawDayLabel(r.draw_date)}</p>
                            </div>
                            {r.winner_name && <p className="font-extrabold tabular-nums">£{r.amount_won}</p>}
                          </div>
                        ))}
                        {rows.length > 5 && (
                          <button className={UI.ghost + ' w-full'} onClick={() => setShowAllWinners((v) => !v)}>{showAllWinners ? 'Show fewer' : `Show all ${rows.length}`}</button>
                        )}
                      </>
                    );
                  })()}
                </section>

                <p className={`text-sm text-center px-4 pt-2 ${UI.dim}`}>£2 a ball each week. Drawn Saturday 8pm using the National Lottery bonus ball. If the ball that comes up isn't paid, the whole pot rolls over.</p>
              </main>
            </div>
          )}

          {/* ACCOUNT SHEET */}
          {showAccount && (
            <div className="fixed inset-0 z-[150] flex items-end sm:items-center justify-center">
              <div className="absolute inset-0 bg-black/40" onClick={() => setShowAccount(false)} />
              <div className="relative w-full max-w-md bg-white rounded-t-3xl sm:rounded-3xl p-6 space-y-3">
                <p className={`text-sm ${UI.dim}`}>Signed in as</p>
                <p className="font-extrabold break-all -mt-2">{sessionEmail}</p>
                {isAdmin && <button className={UI.btn + ' w-full py-3.5'} onClick={() => { setActiveTab('admin'); setShowAccount(false); }}>Open admin</button>}
                <button className={UI.ghost + ' w-full py-3.5'} onClick={enableNotifications}>Turn on notifications</button>
                <button className={UI.ghost + ' w-full py-3.5'} onClick={signOut}>Sign out</button>
                <button className={`w-full py-2 text-sm font-bold ${UI.dim}`} onClick={() => setShowAccount(false)}>Close</button>
              </div>
            </div>
          )}

          {/* ASSIGN / EDIT OWNER */}
          {adminAction && adminAction.type === 'assign' && isAdmin && (
            <div className="fixed inset-0 z-[500] flex items-end sm:items-center justify-center">
              <div className="absolute inset-0 bg-black/40" onClick={() => setAdminAction(null)} />
              <div className="relative w-full max-w-md bg-white rounded-t-3xl sm:rounded-3xl p-6 space-y-3 text-center">
                <LotteryBall number={adminAction.ballNum!} hideShadow className="w-24 h-24 mx-auto" />
                <h3 className="text-xl font-extrabold">Who has ball {adminAction.ballNum}?</h3>
                <input autoFocus aria-label="Name" value={assignmentName} onChange={(e) => setAssignmentName(e.target.value)} placeholder="Name" className={UI.input} />
                <select aria-label="Link to a login" value={selectedMemberId} onChange={(e) => setSelectedMemberId(e.target.value)} className={UI.input}>
                  <option value="">Not linked to a login</option>
                  {(members as any[]).map((member) => (
                    <option key={member.id} value={member.id}>{member.full_name} ({member.email})</option>
                  ))}
                </select>
                <button className={UI.btn + ' w-full py-3.5'} onClick={commitAssignment}>Save</button>
                <button type="button" onClick={handleResetToVacant} className="w-full py-3 rounded-xl bg-red-50 text-red-700 font-bold">Make this ball free again</button>
                <button className={`w-full py-2 text-sm font-bold ${UI.dim}`} onClick={() => setAdminAction(null)}>Cancel</button>
              </div>
            </div>
          )}

          {/* BALL DETAIL SHEET */}
          {selectedBallNum && !adminAction && (
            <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
              <div className="absolute inset-0 bg-black/40" onClick={() => { setSelectedBallNum(null); setPayBall(null); }} />
              <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl p-6 text-center space-y-3">
                <div className="w-28 h-28 mx-auto">{renderBall(selectedBallNum, ballStatus(selectedBall), 'w-28 h-28 text-3xl')}</div>
                {selectedBall && (() => {
                  const weeks = weeksCoveredFor(selectedBall);
                  const status = ballStatus(selectedBall);
                  const winsHere = (winnerRows as any[]).filter((r) => Number(r.winning_number) === selectedBallNum && r.winner_name && (hasSeenLatestReveal || r.id !== (latestWin as any)?.id));
                  return (
                    <>
                      <p className="text-2xl font-extrabold tracking-tight">{selectedBall.owner ?? `Ball ${selectedBallNum} is free`}</p>
                      <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${status === 'in' ? 'bg-green-100 text-green-800' : status === 'out' ? 'bg-red-100 text-red-700' : 'bg-[#e9ecf2] text-[#5a6270]'}`}>
                        {status === 'in' ? `In. Paid up to ${shortDate(selectedBall.paidUntil)} (${weeks} draw${weeks === 1 ? '' : 's'})` : status === 'out' ? 'Not paid for Saturday' : 'Ask Carl if you want it'}
                      </span>
                      {winsHere.length > 0 && (
                        <div className="pt-3 border-t border-[#e9ecf2] text-left">
                          <p className={UI.label + ' mb-1.5'}>Won {winsHere.length} time{winsHere.length === 1 ? '' : 's'}</p>
                          {winsHere.slice(0, 5).map((r) => (
                            <p key={r.id} className="flex justify-between text-sm"><span className={UI.dim}>{drawDayLabel(r.draw_date)}</span><span className="font-bold">{r.winner_name}, £{r.amount_won}</span></p>
                          ))}
                        </div>
                      )}
                      {isAdmin && (
                        <div className="pt-3 border-t border-[#e9ecf2] space-y-2">
                          {selectedBall.owner ? (
                            <div className="flex gap-2">
                              <button className={(payBall === selectedBallNum ? UI.ghost : UI.btn) + ' flex-1 py-3'} onClick={() => openPay(selectedBallNum)}>{payBall === selectedBallNum ? 'Close payment' : 'Record payment'}</button>
                              <button className={UI.ghost + ' flex-1 py-3'} onClick={() => openEditModal(selectedBallNum)}>Edit owner</button>
                            </div>
                          ) : (
                            <button className={UI.btn + ' w-full py-3'} onClick={() => openAssignModal(selectedBallNum)}>Assign this ball</button>
                          )}
                          {payBall === selectedBallNum && renderPayPanel(selectedBall)}
                        </div>
                      )}
                    </>
                  );
                })()}
                <button className={`w-full py-2 text-sm font-bold ${UI.dim}`} onClick={() => { setSelectedBallNum(null); setPayBall(null); }}>Close</button>
              </div>
            </div>
          )}

          {/* INBOX */}
          {showInbox && (
            <div className="fixed inset-0 z-[200] bg-[#f1f3f7] overflow-y-auto">
              <div className="max-w-lg mx-auto p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="flex-1 text-2xl font-extrabold tracking-tight">Notifications</h3>
                  {notifications.length > 0 && <button className={UI.ghost + ' bg-white'} onClick={clearAllNotifications}>Clear all</button>}
                  <button className={UI.ghost + ' bg-white'} onClick={() => setShowInbox(false)}>Close</button>
                </div>
                {notifications.length === 0 ? (
                  <p className={`text-center py-12 ${UI.dim}`}>Nothing here yet.</p>
                ) : notifications.map((n) => (
                  <div key={n.id} className={UI.card + ' flex items-start gap-3'}>
                    <div className="flex-1 min-w-0">
                      <p className="font-extrabold">{n.title}</p>
                      <p className={`text-sm ${UI.dim}`}>{n.body}</p>
                      <p className={`text-xs mt-1 ${UI.dim}`}>{n.timestamp}</p>
                    </div>
                    <button aria-label="Dismiss" className={`w-8 h-8 rounded-full bg-[#e9ecf2] ${UI.dim}`} onClick={() => dismissNotification(n.id)}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RECOVERY MODAL (blocking) */}
          {isRecoveryMode && (
            <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-black/50">
              <div className="w-full max-w-md bg-white rounded-3xl p-6 text-center space-y-3">
                <h3 className="text-2xl font-extrabold">Set a new password</h3>
                <p className={`text-sm ${UI.dim}`}>Choose a new password before you carry on.</p>
                <form onSubmit={handleRecoveryPasswordSubmit} className="space-y-3">
                  <input type="password" required aria-label="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={UI.input} placeholder="New password" />
                  <button type="submit" disabled={!newPassword || isUpdatingPassword} className={UI.btn + ' w-full py-3.5'}>{isUpdatingPassword ? 'Updating…' : 'Update password'}</button>
                </form>
              </div>
            </div>
          )}
        </>
      ) : (
        /* ============================ SIGN IN ============================ */
        <main className="min-h-screen max-w-lg mx-auto flex flex-col">
          <div className="relative overflow-hidden rounded-b-[2rem] bg-[#1f6fd0] text-white px-6 pt-14 pb-10">
            <div className="login-ball" style={{ left: '8%', top: '18%', width: 64, animationDelay: '0s' }}><LotteryBall number={7} hideShadow className="w-full" /></div>
            <div className="login-ball" style={{ right: '10%', top: '10%', width: 84, animationDelay: '-3s' }}><LotteryBall number={24} hideShadow className="w-full" /></div>
            <div className="login-ball" style={{ right: '24%', bottom: '8%', width: 56, animationDelay: '-6s' }}><LotteryBall number={42} hideShadow className="w-full" /></div>
            <h1 className="relative text-6xl font-extrabold tracking-tighter leading-none">Bonus<br />Ball</h1>
            <p className="relative font-semibold mt-3 opacity-90">Every Saturday, 8pm.</p>
          </div>

          <div className="px-4 py-5">
            <div className={UI.card + ' space-y-4'}>
              {authMode === 'login' && (
                <form onSubmit={handleLogin} className="space-y-3">
                  <div><label htmlFor="login-email" className={UI.label}>Email</label><input id="login-email" name="email" required type="email" autoComplete="email" className={UI.input + ' mt-1'} /></div>
                  <div><label htmlFor="login-password" className={UI.label}>Password</label><input id="login-password" name="password" required type="password" autoComplete="current-password" className={UI.input + ' mt-1'} /></div>
                  <button type="submit" className={UI.btn + ' w-full py-3.5 text-base'}>Sign in</button>
                  <div className="flex justify-between text-sm font-bold">
                    <button type="button" onClick={() => setAuthMode('register')} className="underline underline-offset-4">Create an account</button>
                    <button type="button" onClick={() => setAuthMode('forgot')} className={UI.dim}>Forgot password?</button>
                  </div>
                </form>
              )}

              {authMode === 'register' && (
                <form onSubmit={handleRegister} className="space-y-3">
                  <div><label htmlFor="reg-name" className={UI.label}>Your name</label><input id="reg-name" name="fullName" required type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} className={UI.input + ' mt-1'} /></div>
                  <div><label htmlFor="reg-email" className={UI.label}>Email</label><input id="reg-email" name="email" required type="email" autoComplete="email" className={UI.input + ' mt-1'} /></div>
                  <div><label htmlFor="reg-password" className={UI.label}>Password</label><input id="reg-password" name="password" required type="password" autoComplete="new-password" className={UI.input + ' mt-1'} /></div>
                  <button type="submit" className={UI.btn + ' w-full py-3.5 text-base'}>Create account</button>
                  <button type="button" onClick={() => setAuthMode('login')} className={`w-full text-sm font-bold ${UI.dim}`}>I already have an account</button>
                </form>
              )}

              {authMode === 'forgot' && (
                <form onSubmit={handleForgotPassword} className="space-y-3">
                  <div><label htmlFor="forgot-email" className={UI.label}>Email</label><input id="forgot-email" name="email" required type="email" autoComplete="email" className={UI.input + ' mt-1'} /></div>
                  <button type="submit" className={UI.btn + ' w-full py-3.5 text-base'}>Send reset email</button>
                  <button type="button" onClick={() => setAuthMode('login')} className={`w-full text-sm font-bold ${UI.dim}`}>Back to sign in</button>
                </form>
              )}

              {authMode === 'reset' && (
                <form onSubmit={handleResetPassword} className="space-y-3">
                  <div><label htmlFor="reset-password" className={UI.label}>New password</label><input id="reset-password" name="password" required type="password" autoComplete="new-password" className={UI.input + ' mt-1'} /></div>
                  <button type="submit" className={UI.btn + ' w-full py-3.5 text-base'}>Set new password</button>
                </form>
              )}
            </div>
          </div>
        </main>
      )}
    </div>
  );
};

export default App;
