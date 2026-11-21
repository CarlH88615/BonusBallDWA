// gitupdate 
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LotteryBall } from './components/LotteryBall';
import { Reveal, REVEAL_KINDS } from './components/Reveal';
import type { RevealKind } from './components/Reveal';
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
  
  // 'random' picks a different reveal for each person each time ("Surprise me").
  type RevealStyle = RevealKind | 'random';
  const REVEAL_STYLES: { value: RevealStyle; label: string; desc: string }[] = [
    ...REVEAL_KINDS.map((k) => ({ value: k.value as RevealStyle, label: k.label, desc: k.desc })),
    { value: 'random', label: 'Surprise Me', desc: 'A different reveal for each person, each time' },
  ];
  const isRevealStyle = (v: unknown): v is RevealStyle => REVEAL_STYLES.some((s) => s.value === v);
  const [revealDefaultStyle, setRevealDefaultStyle] = useState<RevealStyle>(() => {
    if (typeof window === 'undefined') return 'scratch';
    // v2 key: the redesign makes Scratch Off the default, ignoring any older saved choice.
    const saved = localStorage.getItem('reveal_default_style_v2');
    return isRevealStyle(saved) ? saved : 'scratch';
  });
  const setAsDefaultStyle = (style: RevealStyle) => {
    localStorage.setItem('reveal_default_style_v2', style);
    setRevealDefaultStyle(style);
    showToast('success', `Default reveal set to ${REVEAL_STYLES.find((s) => s.value === style)?.label}`);
  };
  // Per-draw override chosen when entering the result. Empty string = use default.
  const [recordRevealStyle, setRecordRevealStyle] = useState<RevealStyle | ''>('');
  const [revealStyle, setRevealStyle] = useState<RevealKind>('scratch'); // the one playing now
  const [revealRun, setRevealRun] = useState(0); // bumps on every play so the reveal remounts fresh
  const [revealStep, setRevealStep] = useState<'idle' | 'running' | 'settled'>('idle');
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
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 8000 : 3500);
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
    setLedgerLoaded(true);
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
    // Draws saved with one of the retired styles fall back to the default.
    const styleForPlayback: RevealStyle = isRevealStyle(persistedStyle) ? persistedStyle : revealDefaultStyle;
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

  const startRevealSequence = (style: RevealStyle = 'scratch') => {
    if (!latestWin) return;
    cancelRevealAnimations();
    const kind: RevealKind =
      style === 'random' ? REVEAL_KINDS[Math.floor(Math.random() * REVEAL_KINDS.length)].value : style;
    setRevealRun((r) => r + 1);
    setRevealStyle(kind);
    setShowWinReveal(true);
    setRevealStep('running');
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
  const lastPushRef = useRef<{ sent: number; failed: number } | null>(null);
  const pushSummary = () => {
    const r = lastPushRef.current;
    if (!r) return 'Sent.';
    return `Sent to ${r.sent} phone${r.sent === 1 ? '' : 's'}${r.failed ? ` (${r.failed} didn't go through)` : ''}.`;
  };
  const fireRealPush = async (title: string, body: string, target: string): Promise<boolean> => {
    lastPushRef.current = null;
    // Give up after 20 seconds so a bad signal can't leave the button stuck on "Sending…".
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("/.netlify/functions/push-broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body, target }),
        signal: controller.signal,
      });
      if (res.ok) {
        const info = await res.json().catch(() => null);
        if (info && typeof info.sent === 'number') lastPushRef.current = { sent: info.sent, failed: Number(info.failed) || 0 };
      }
      return res.ok;
    } catch (e) {
      console.error("Push broadcast failed", e);
      return false;
    } finally {
      clearTimeout(timer);
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
  // Until the ledger has loaded we can't say whether the books balance, so say nothing.
  const [ledgerLoaded, setLedgerLoaded] = useState(false);

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
      // Unpaid: faded, with a dashed ring so it can't be mistaken for a white ball.
      <div className={`${cls} ${status === 'out' ? 'rounded-full outline-dashed outline-2 outline-[#7d8696]' : ''}`}>
        <div className={status === 'out' ? 'grayscale opacity-40' : ''}>
          <LotteryBall number={num} hideShadow className="w-full h-full" />
        </div>
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
    showToast(ok ? 'success' : 'error', ok ? `Reminder: ${pushSummary()}` : "Couldn't send the reminder. Check your signal and try again.");
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

  // Sends only to the signed-in person's own devices, and says why if it fails.
  const sendTestPush = async () => {
    const { data } = await supabase.auth.getUser();
    const userId = data.user?.id;
    if (!userId) {
      showToast('error', 'Not logged in.');
      return;
    }
    try {
      const res = await fetch('/.netlify/functions/push-broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Bonus Ball test', body: 'Notifications are working on this phone.', userId }),
      });
      const text = await res.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch { /* plain text */ }
      if (!res.ok || !j) { showToast('error', text.slice(0, 160) || 'Test failed.'); return; }
      if (j.total === 0) { showToast('error', 'This login has no phone signed up. Tap your initial, then Turn on notifications.'); return; }
      if (j.failed > 0) {
        const f = j.failures?.[0];
        showToast('error', `Sent to ${j.sent} of ${j.total} of your devices. Failed: ${f?.service ?? ''} ${f?.status ?? ''} ${f?.reason ?? ''}`.trim());
        return;
      }
      showToast('success', `Sent to ${j.sent} of your device${j.sent === 1 ? '' : 's'}. It should arrive in a few seconds.`);
    } catch (err: any) {
      showToast('error', err?.message ?? 'Test failed.');
    }
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
        showToast(ok ? 'success' : 'error', ok ? pushSummary() : "Couldn't send. Check your signal and try again.");
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

      {/* THE REVEAL */}
      {showWinReveal && latestWin && (
        <Reveal
          key={`${latestWin.id}-${revealRun}`}
          kind={revealStyle}
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
          onSound={(kind, freq) => {
            if (kind === 'tick') playTick();
            else if (kind === 'pop') playExplosion();
            else if (kind === 'whoosh') playWhoosh();
            else if (kind === 'drum') playTone(120, 90, 0.25, 'square');
            else playTone(freq ?? 440, 140, 0.15, 'triangle');
          }}
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
                        <p className={`text-xs font-bold ${!ledgerLoaded ? 'text-[#5a6270]' : booksOk ? 'text-green-700' : 'text-red-600'}`}>{!ledgerLoaded ? 'Bank' : booksOk ? 'Bank ✓' : 'Bank: check'}</p>
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
                      <span className={`inline-block mt-2 rounded-full px-3 py-1 text-sm font-bold ${!ledgerLoaded ? 'bg-[#e9ecf2] text-[#5a6270]' : booksOk ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}`}>{!ledgerLoaded ? 'Checking the books…' : booksOk ? 'Books balance' : "Books don't balance"}</span>
                      <dl className="mt-4 text-sm space-y-1.5">
                        <div className="flex justify-between"><dt className={UI.dim}>Prepaid weeks + rollover should be</dt><dd className={`font-bold tabular-nums ${Math.abs(bankBalance - expectedBankTotal) < 0.01 ? '' : 'text-red-600'}`}>£{Number(expectedBankTotal).toFixed(2)}</dd></div>
                        <div className="flex justify-between"><dt className={UI.dim}>Ledger adds up to</dt><dd className={`font-bold tabular-nums ${!ledgerLoaded || Math.abs(bankBalance - ledgerNet) < 0.01 ? '' : 'text-red-600'}`}>{ledgerLoaded ? `£${Number(ledgerNet).toFixed(2)}` : '…'}</dd></div>
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
                      {REVEAL_STYLES.map((opt) => {
                        const isDefault = revealDefaultStyle === opt.value;
                        return (
                          <div key={opt.value} className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="font-bold">{opt.label}{isDefault && <span className="ml-2 text-xs font-bold bg-[#14161c] text-white rounded-full px-2 py-0.5">Default</span>}</p>
                              <p className={`text-xs ${UI.dim}`}>{opt.desc}</p>
                            </div>
                            <button className={UI.ghost + ' px-3'} disabled={!latestWin} onClick={() => startRevealSequence(opt.value)}>Preview</button>
                            {!isDefault && <button className={UI.ghost + ' px-3'} onClick={() => setAsDefaultStyle(opt.value)}>Use</button>}
                          </div>
                        );
                      })}
                    </div>
                    <div className={UI.card + ' flex items-center gap-3'}>
                      <div className="flex-1"><p className="font-bold">Send a test notification</p><p className={`text-xs ${UI.dim}`}>Goes only to your own phone.</p></div>
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
                  <p className={`text-xs ${UI.dim}`}>Colour means in. Faded with a dashed ring means not paid. Dotted means free. Tap any ball to see whose it is.</p>
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
