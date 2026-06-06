// gitupdate 
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LotteryBall } from './components/LotteryBall';
import { supabase } from "./services/supabase";
import type { BallState, NotificationMessage, Tab, AuthMode } from './types';

const AnimatedBallsBackground = ({ smallBalls }: { smallBalls: BallState[] }) => {
  return (
    <div className="fixed inset-0 z-0 pointer-events-none opacity-20 overflow-hidden">
      {smallBalls.map((ball) => (
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
  );
};




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
  
  type RevealStyle = 'slot' | 'bingo' | 'tile' | 'curtain';
  const REVEAL_STYLES: { value: RevealStyle; label: string }[] = [
    { value: 'slot', label: 'Slot Machine' },
    { value: 'bingo', label: 'Bingo Eliminate' },
    { value: 'tile', label: 'Tile Flip' },
    { value: 'curtain', label: 'Stage Curtain' },
  ];
  const [revealDefaultStyle, setRevealDefaultStyle] = useState<RevealStyle>(() => {
    if (typeof window === 'undefined') return 'slot';
    const saved = localStorage.getItem('reveal_default_style');
    if (saved === 'slot' || saved === 'bingo' || saved === 'tile' || saved === 'curtain') return saved;
    return 'slot';
  });
  const setAsDefaultStyle = (style: RevealStyle) => {
    localStorage.setItem('reveal_default_style', style);
    setRevealDefaultStyle(style);
    showToast('success', `Default reveal set to ${REVEAL_STYLES.find((s) => s.value === style)?.label}`);
  };
  // Per-draw override chosen in the Record Result modal. Empty string = use default.
  const [recordRevealStyle, setRecordRevealStyle] = useState<RevealStyle | ''>('');
  const [revealStyle, setRevealStyle] = useState<RevealStyle>('slot');
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
  const [totalCharityRaised, setTotalCharityRaised] = useState<number>(0);
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
      persistedStyle === 'slot' || persistedStyle === 'bingo' || persistedStyle === 'tile' || persistedStyle === 'curtain'
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
        return;
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
    startRevealSequence(latestWin.revealStyle);
    localStorage.setItem(key, 'true');
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

  const startRevealSequence = (style: RevealStyle = 'slot') => {
    if (!latestWin) return;
    cancelRevealAnimations();
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
  const fetchCharityTotal = async () => {
    const { data, error } = await supabase
      .from("bonus_ball_ledger")
      .select("amount")
      .eq("type", "charity");

    if (error) {
      console.error("❌ Failed to fetch charity total", error);
      return;
    }

    const total = (data ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
    setTotalCharityRaised(total);
  };

  fetchCharityTotal();
}, []);
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
    const num = adminAction?.ballNum;
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
    }

    const ballsLabel = affectedNumbers.map((n) => `#${n}`).join(', ');
    const newPaidThrough = updatedBalls.find((b) => b.number === affectedNumbers[0])?.paidUntil;
    const throughLabel = newPaidThrough ? ` through ${formatPaidUntil(newPaidThrough)}` : '';
    showToast("success", `Ball${affectedNumbers.length > 1 ? 's' : ''} ${ballsLabel} paid${throughLabel} (£${paymentAmount}).`);
    sendPush("Payment Logged", `Ball${affectedNumbers.length > 1 ? 's' : ''} ${ballsLabel} paid${throughLabel}`, "admin", "reminder");
    setAdminAction(null);
    setPaymentWeeks('1');
    setApplyToAllOwner(false);
    setSelectedBallNum(null);
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

  return (
    <div className="relative min-h-screen bg-[#020407] overflow-hidden flex flex-col font-display z-10">
      <AnimatedBallsBackground smallBalls={smallBalls} />
      {/* TOAST */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] max-w-[90vw] sm:max-w-md flex items-center gap-3 bg-neutral-900 border border-neutral-700 rounded-2xl px-5 py-3 shadow-2xl">
          <span className={`text-xl leading-none ${toast.kind === 'error' ? 'text-red-400' : toast.kind === 'success' ? 'text-green-400' : 'text-pink-400'}`}>●</span>
          <span className="text-sm text-white">{toast.message}</span>
        </div>
      )}
      {/* WIN REVEAL */}
      {showWinReveal && (
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
                  <button onClick={() => { cancelRevealAnimations(); setShowWinReveal(false); }} className="px-10 py-4 bg-white text-black font-black uppercase text-[10px] tracking-[0.2em] rounded-full hover:bg-pink-500 hover:text-white transition-all shadow-2xl active:scale-95">Open Dashboard</button>
                </div>
              </>
            ) : (
              <>
                <p className="text-yellow-400 font-black uppercase tracking-[0.5em] text-xs md:text-sm mb-2 animate-pulse">🎉 Congratulations 🎉</p>
                <p className="text-pink-500 font-black uppercase tracking-[0.5em] text-[10px] mb-3">Saturday Draw Winner</p>
                <h2 className="text-4xl md:text-7xl font-black text-white tracking-tighter uppercase leading-none mb-2 drop-shadow-2xl">{latestWin?.winner}</h2>
                <p className="text-yellow-400 font-black text-2xl md:text-5xl tracking-tighter drop-shadow-xl">£{latestWin?.prizeAmount || 0}</p>
                <div className="mt-6">
                  <button onClick={() => { cancelRevealAnimations(); setShowWinReveal(false); }} className="px-10 py-4 bg-white text-black font-black uppercase text-[10px] tracking-[0.2em] rounded-full hover:bg-pink-500 hover:text-white transition-all shadow-2xl active:scale-95">Open Dashboard</button>
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
                    showToast("error", "Notifications permission not granted.");
                    return;
                  }

                  const reg = await navigator.serviceWorker.ready;
                  const sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: VAPID_PUBLIC_KEY,
                  });

                  console.log("Push subscription:", JSON.stringify(sub));
                  const {
                    data: { user },
                    error: userErr,
                  } = await supabase.auth.getUser();

                  if (userErr || !user) {
                    showToast("error", "Not logged in.");
                    return;
                  }

                  const json = sub.toJSON();
                  const endpoint = json.endpoint;
                  const p256dh = json.keys?.p256dh;
                  const auth = json.keys?.auth;

                  if (!endpoint || !p256dh || !auth) {
                    showToast("error", "Subscription missing required fields.");
                    return;
                  }

                  const { error: upsertErr } = await supabase.from("push_subscriptions").upsert(
                    {
                      user_id: user.id,
                      endpoint,
                      p256dh,
                      auth,
                      active: true,
                      created_at: new Date().toISOString(),
                    },
                    { onConflict: "endpoint" }
                  );

                  if (upsertErr) {
                    showToast("error", upsertErr.message);
                    return;
                  }

                  showToast("success", "Subscribed — you'll receive draw notifications.");

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
                    showToast("error", "No user (not logged in)");
                    return;
                  }

                  await navigator.clipboard.writeText(id);
                  showToast("success", "User ID copied to clipboard");
                }}
                className="mt-3 px-4 py-2 rounded-full border border-white/10 bg-white/5 text-white/60 hover:text-white transition-all text-[10px] font-black uppercase tracking-widest"
              >
                Copy User ID
              </button>
            ) : null}
          </header>

          <main className="relative z-10 flex-1 p-4 sm:p-6 pb-32 sm:pb-40">
            <div className="max-w-6xl mx-auto">
              {activeTab === 'home' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
                  {!noticeDismissed && (
                    <div className="bg-red-500/10 border border-red-500/20 rounded-[2rem] p-6 md:p-10 shadow-2xl relative">
                      <button onClick={dismissNotice} aria-label="Dismiss" className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 text-white/40 hover:text-white text-sm flex items-center justify-center">✕</button>
                      <div className="flex items-start gap-4 sm:gap-6 pr-8">
                        <div className="w-12 h-12 rounded-2xl bg-red-500 flex items-center justify-center flex-shrink-0 text-white shadow-lg"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg></div>
                        <div>
                          <h4 className="text-xl font-black text-white tracking-tighter uppercase mb-2">Heads Up</h4>
                          <p className="text-white/60 text-sm leading-relaxed max-w-xl">Unpaid winners forfeit the full prize — 100% rolls over to the next draw. Please keep your entries current.</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* PERSONALISED HERO — signed-in users with balls */}
                  {sessionEmail && myBalls.length > 0 && (
                    <div className="bg-gradient-to-br from-pink-500/20 via-pink-500/10 to-transparent border border-pink-500/20 rounded-[2.5rem] p-6 md:p-10 shadow-2xl">
                      <p className="text-[10px] font-black uppercase tracking-[0.3em] text-pink-400 mb-2">Welcome back</p>
                      <h3 className="text-3xl md:text-4xl font-black text-white tracking-tighter mb-6">
                        You own {myBalls.length === 1 ? 'Ball' : `${myBalls.length} Balls`} {myBalls.map((b) => `#${b.number}`).join(', ')}
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {myBalls.map((b) => {
                          const weeks = weeksCoveredFor(b);
                          const isPaid = weeks > 0;
                          return (
                            <button
                              key={b.number}
                              onClick={() => setSelectedBallNum(b.number)}
                              className={`flex items-center gap-4 p-4 rounded-2xl border text-left transition-all ${isPaid ? 'bg-white/5 border-white/10 hover:bg-white/10' : 'bg-red-500/10 border-red-500/20 hover:bg-red-500/15'}`}
                            >
                              <LotteryBall number={b.number} className="w-12 h-12 flex-shrink-0" opacity={isPaid ? 1 : 0.4} />
                              <div className="flex-1 min-w-0">
                                <p className={`text-xs font-black uppercase tracking-widest mb-0.5 ${isPaid ? 'text-pink-400' : 'text-red-400'}`}>
                                  {isPaid ? `Covered · ${weeks} week${weeks === 1 ? '' : 's'} left` : 'Not covered'}
                                </p>
                                <p className="text-sm text-white font-semibold truncate">
                                  {isPaid ? `Paid through ${formatPaidUntil(b.paidUntil)}` : 'Pay to enter the next draw'}
                                </p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* LATEST DRAW RESULT — hidden until the user has watched the reveal */}
                  {latestWin && hasSeenLatestReveal && (
                    <div className={`backdrop-blur-xl border rounded-[2.5rem] p-6 md:p-8 shadow-2xl flex items-center gap-4 md:gap-6 ${latestWin.isRollover ? 'bg-orange-500/[0.06] border-orange-500/30' : 'bg-white/[0.03] border-white/10'}`}>
                      <LotteryBall number={latestWin.ballNumber} className="w-20 h-20 md:w-24 md:h-24 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className={`text-[10px] font-black uppercase tracking-[0.3em] mb-1 ${latestWin.isRollover ? 'text-orange-400' : 'text-pink-400'}`}>Last Draw · {latestWin.date}</p>
                        {latestWin.isRollover ? (
                          <>
                            <h4 className="text-2xl md:text-3xl font-black text-white tracking-tighter truncate">🔥 Rollover</h4>
                            <p className="text-orange-400 font-black text-base md:text-lg">£{latestWin.rolloverAmount} carried forward</p>
                          </>
                        ) : (
                          <>
                            <h4 className="text-2xl md:text-3xl font-black text-white tracking-tighter truncate">{latestWin.winner}</h4>
                            <p className="text-yellow-500 font-black text-xl">£{latestWin.prizeAmount}</p>
                          </>
                        )}
                      </div>
                      <button onClick={() => startRevealSequence(latestWin?.revealStyle)} className="hidden sm:block px-4 py-2 rounded-full bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-widest text-white/60 hover:text-white hover:bg-white/10">Replay</button>
                    </div>
                  )}

                  {/* ONBOARDING — first-time signed-in users */}
                  {sessionEmail && !seenOnboarding && (
                    <div className="bg-pink-500/10 border border-pink-500/20 rounded-[2.5rem] p-6 md:p-8 shadow-2xl relative">
                      <button onClick={completeOnboarding} aria-label="Dismiss" className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 text-white/40 hover:text-white text-sm flex items-center justify-center">✕</button>
                      <h4 className="text-xl font-black text-white tracking-tighter uppercase mb-3">Getting Started</h4>
                      <ol className="space-y-3 text-sm text-white/70 list-decimal list-inside">
                        <li>Browse the <button onClick={() => setActiveTab('balls')} className="text-pink-400 underline underline-offset-2">Balls tab</button> to see what's available.</li>
                        <li>Ask Carl to assign a ball to you and mark you as paid.</li>
                        <li>Tap the bell icon in the header to subscribe to push notifications so you get the result on Saturday.</li>
                      </ol>
                      <button onClick={completeOnboarding} className="mt-5 text-xs font-black uppercase tracking-widest text-pink-400 hover:text-pink-300">Got it →</button>
                    </div>
                  )}

                  {/* GUIDELINES — show for not-logged-in or users with no balls */}
                  {(!sessionEmail || myBalls.length === 0) && (
                    <div className="bg-white/[0.03] backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-6 md:p-10 shadow-2xl space-y-8">
                      <div>
                        <h3 className="text-3xl md:text-4xl font-black text-white tracking-tighter mb-4">The Guidelines</h3>
                        <p className="text-white/60 text-sm leading-relaxed max-w-lg">
                          A family initiative — £2 per ball, drawn every Saturday night using the National Lottery Bonus Ball.
                          {sessionEmail && myBalls.length === 0 && ' Ask Carl to assign you a ball to get started.'}
                        </p>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        <div className="flex gap-4 p-5 bg-white/5 rounded-3xl border border-white/5">
                          <div className="w-10 h-10 rounded-xl bg-pink-500/20 flex items-center justify-center text-pink-500"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1" /></svg></div>
                          <div><p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">Weekly Entry</p><p className="text-white font-bold text-lg">£2</p></div>
                        </div>
                        <div className="flex gap-4 p-5 bg-white/5 rounded-3xl border border-white/5">
                          <div className="w-10 h-10 rounded-xl bg-pink-500/20 flex items-center justify-center text-pink-500"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14" /></svg></div>
                          <div><p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">Draw Night</p><p className="text-white font-bold text-lg">Saturday 8pm</p></div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'balls' && (
                <div className="animate-in fade-in zoom-in-95 duration-500 space-y-10">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={`border rounded-3xl p-8 flex items-center justify-between shadow-xl ${drawAwaitingResult ? 'bg-orange-500/[0.06] border-orange-500/30' : 'bg-white/[0.03] border-white/10'}`}><div><p className={`text-[10px] font-black uppercase tracking-widest mb-1 ${drawAwaitingResult ? 'text-orange-400' : 'text-white/30'}`}>{drawAwaitingResult ? 'Awaiting Result' : 'Upcoming Draw'}</p><p className="text-2xl font-black text-white">{formattedDrawDate}</p></div><div className={`w-12 h-12 rounded-full border flex items-center justify-center font-black text-xs ${drawAwaitingResult ? 'border-orange-500/40 text-orange-400' : 'border-white/10 text-white/20'}`}>{drawAwaitingResult ? '⏱' : 'Sat'}</div></div>
                    <div className={`relative border rounded-3xl p-6 sm:p-8 shadow-xl w-full overflow-hidden ${totalRollover > 0 ? 'bg-gradient-to-br from-orange-500/20 via-yellow-500/10 to-transparent border-yellow-500/30' : 'bg-white/[0.03] border-white/10'}`}>
                      {totalRollover > 0 && (
                        <div className="absolute -top-2 -right-2 px-3 py-1 rounded-full bg-gradient-to-r from-pink-500 via-orange-400 to-yellow-400 animate-pulse shadow-[0_0_25px_rgba(255,120,0,0.6)]">
                          <span className="text-black font-black tracking-widest text-[10px]">🔥 ROLLOVER</span>
                        </div>
                      )}
                      <div className="flex items-end justify-between gap-3">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">Active Prize</p>
                          <p className={`text-5xl sm:text-6xl font-black tracking-tighter ${totalRollover > 0 ? 'text-yellow-400 drop-shadow-[0_0_25px_rgba(250,204,21,0.4)]' : 'text-white'}`}>£{currentPot}</p>
                          {rolloverStreak >= 2 && (
                            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-orange-400 mt-2">
                              {rolloverStreak} weeks of rollover 🔥
                            </p>
                          )}
                        </div>
                        <div className="self-start px-3 py-1 bg-pink-500 text-black text-[10px] font-black rounded-full uppercase">Live</div>
                      </div>
                      <div className="mt-4 space-y-1 text-xs text-white/60 font-bold uppercase tracking-widest">
                        <div className="flex justify-between">
                          <span>This draw</span>
                          <span>£{currentPot - totalRollover}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Rollover</span>
                          <span>£{totalRollover}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="bg-black/40 backdrop-blur-md border border-white/5 rounded-[2rem] sm:rounded-[3rem] p-4 sm:p-10 md:p-14 shadow-2xl">
                    <div className="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-3 sm:gap-6">
                      {balls.map((ball) => {
                        const num = ball.number;
                        const ownerName = ball?.owner;
                        const isPaid = isBallPaidForDraw(ball);
                        return (
                          <div key={num} onClick={() => setSelectedBallNum(num)} className="group cursor-pointer transition-all flex flex-col items-center gap-1.5">
                            <LotteryBall number={num} className="w-full group-hover:scale-110 transition-transform" opacity={isPaid ? 1 : 0.1} />
                            <p className={`text-[10px] sm:text-[8px] font-black uppercase truncate w-full text-center mt-1 transition-colors ${isPaid ? 'text-white/80' : 'text-white/20'}`}>
                              {ownerName
                                ? `${ownerName}${isPaid ? '' : ' ⚠️'}`
                                : 'Open'}
                            </p>
                            <p className="hidden sm:block text-[8px] font-bold uppercase text-center text-white/30">
                              {isPaid
                                ? `Paid until ${formatPaidUntil(ball.paidUntil)}`
                                : 'Expired'}
                            </p>
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
                        <div className="text-center py-20 text-white/40">
                          <p className="font-black uppercase tracking-widest mb-2">No results yet</p>
                          <p className="text-xs text-white/30">Winners will appear here after the first draw is recorded.</p>
                        </div>
                      ) : winnerRows.map((r, i) => (
                        <div key={i} className="bg-white/[0.03] backdrop-blur-xl border border-white/10 p-6 md:p-8 rounded-[2rem] flex items-center gap-6 md:gap-10 hover:bg-white/5 transition-all group">
                          <LotteryBall number={r.winning_number} className="w-16 h-16 md:w-20 md:h-20 group-hover:rotate-12 transition-transform flex-shrink-0" />
                          <div className="flex-1 flex flex-col md:flex-row md:items-center justify-between gap-4 min-w-0">
                            <div className="min-w-0">
                              <p className="text-[10px] font-black uppercase text-pink-500 tracking-widest mb-1">{r.draw_date}</p>
                              <h4 className="text-2xl md:text-3xl font-black text-white tracking-tighter leading-none truncate">{r.winner_name ?? 'VACANT'}</h4>
                            </div>
                            <div className="flex items-center gap-4">
                              <div className="text-right">
                                <p className="text-[10px] font-black uppercase text-white/30 mb-1">Awarded</p>
                                <p className="text-2xl md:text-3xl font-black text-yellow-500 tracking-tighter">£{r.amount_won}</p>
                              </div>
                              {i === 0 && r.winner_name && (
                                <button
                                  onClick={() => startRevealSequence(latestWin?.revealStyle)}
                                  title="Replay reveal"
                                  className="w-10 h-10 rounded-full bg-pink-500/10 hover:bg-pink-500/20 border border-pink-500/30 text-pink-400 flex items-center justify-center flex-shrink-0"
                                >
                                  ▶
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                </div>
              )}

              {activeTab === 'admin' && isAdmin && (
                <div className="animate-in fade-in slide-in-from-bottom-8 duration-500 space-y-12">
                  {/* DUE THIS WEEK — at the top so the admin sees it first */}
                  {ballsDueThisWeek.length > 0 && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-[2.5rem] p-6 md:p-10 shadow-2xl">
                      <div className="flex items-center justify-between mb-6">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-400 mb-1">Action needed</p>
                          <h4 className="text-2xl md:text-3xl font-black text-white tracking-tighter">
                            {ballsDueThisWeek.length} ball{ballsDueThisWeek.length === 1 ? '' : 's'} not covered for next draw
                          </h4>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {ballsDueThisWeek.map((b) => (
                          <div key={b.number} className="flex items-center justify-between bg-black/30 border border-white/5 rounded-2xl p-3 sm:p-4">
                            <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                              <LotteryBall number={b.number} className="w-10 h-10 flex-shrink-0" opacity={0.5} />
                              <div className="min-w-0">
                                <p className="text-sm font-black text-white truncate">{b.owner}</p>
                                <p className="text-[10px] font-bold uppercase text-white/40 truncate">
                                  {b.paidUntil ? `Expired ${formatPaidUntil(b.paidUntil)}` : 'Never paid'}
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => handleUpdatePaymentInitiate(b.number)}
                              className="ml-2 px-3 sm:px-4 py-2 bg-pink-500 text-black font-black text-[10px] sm:text-xs uppercase tracking-widest rounded-xl hover:bg-pink-400 flex-shrink-0"
                            >
                              Mark Paid
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

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
                      </div>
                      <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                        {balls.map((ball) => {
                            const num = ball.number;
                            const ownerName = ball?.owner;
                            const isPaid = isBallPaidForDraw(ball);
                            const notCovered = !isPaid;
                            const matchesSearch =
                              !adminSearchTerm ||
                              num.toString().includes(adminSearchTerm) ||
                              (ownerName && ownerName.toLowerCase().includes(adminSearchTerm.toLowerCase()));
                            if (!matchesSearch) return null;
                            if (showNotCoveredOnly && !notCovered) return null;
                            return (
                              <div key={num} className="bg-white/[0.02] border border-white/5 p-4 rounded-2xl flex items-center justify-between hover:bg-white/[0.05] transition-all">
                                <div className="flex items-center gap-4">
                                  <LotteryBall number={num} className="w-10 h-10" opacity={isPaid ? 1 : 0.2} />
                                  <div>
                                    <p className="text-sm font-black text-white leading-none">
                                      {ownerName ?? `Vacant Ball #${num}`}{!isPaid && ' ⚠️'}
                                    </p>
                                    <p className="text-[9px] font-bold uppercase mt-1 text-white/30">
                                      {isPaid ? `Paid until and including ${formatPaidUntil(ball.paidUntil)}` : 'Expired'}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  {ownerName ? (
                                    <>
                                      <button onClick={() => handleUpdatePaymentInitiate(num)} className="px-3 py-1.5 text-[9px] font-black uppercase rounded-lg bg-pink-500 text-black hover:bg-pink-400 transition-all">Record Payment</button>
                                      <button
                                        onClick={() => openEditModal(num)}
                                        className="p-2 bg-white/5 text-white/30 hover:text-white rounded-lg"
                                      >
                                        Edit
                                      </button>
                                    </>
                                  ) : (
                                    <button onClick={() => openAssignModal(num)} className="px-3 py-1.5 bg-white/5 text-white/40 text-[9px] font-black uppercase rounded-lg hover:bg-white/10 transition-all">Assign Member</button>
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
                        </div>
                        <button
                          onClick={() => setShowLedger(true)}
                          className="mt-4 w-full rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white py-3"
                        >
                          View Ledger
                        </button>
                      </div>

                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-8 md:p-10 shadow-2xl">
                        <h4 className="text-2xl font-black text-white uppercase tracking-tighter mb-2">Reveal Lab</h4>
                        <p className="text-[11px] text-white/40 mb-6">Preview each style and set your default. The Record Result modal lets you override per draw.</p>
                        {!latestWin && (
                          <p className="text-xs text-white/50 italic">No latest winner to preview — record a draw first.</p>
                        )}
                        {latestWin && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {[
                              { value: 'slot' as RevealStyle, title: 'Slot Machine', desc: 'Huge number cycles fast, slows with a thunk' },
                              { value: 'bingo' as RevealStyle, title: 'Bingo Eliminate', desc: 'All 59 balls, eliminated until three remain in a final showdown' },
                              { value: 'tile' as RevealStyle, title: 'Tile Flip', desc: '"?" tiles sweep-flip, winner glows last' },
                              { value: 'curtain' as RevealStyle, title: 'Stage Curtain', desc: 'Red curtains shake, then part dramatically' },
                            ].map((opt) => {
                              const isDefault = revealDefaultStyle === opt.value;
                              return (
                                <div key={opt.value} className={`p-4 rounded-2xl border transition-all ${isDefault ? 'bg-pink-500/10 border-pink-500/40' : 'bg-white/5 border-white/10'}`}>
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-black uppercase tracking-widest text-pink-400">{opt.title}</span>
                                    {isDefault && <span className="text-[9px] font-black uppercase tracking-widest text-pink-300 px-2 py-0.5 bg-pink-500/20 rounded-full">Default</span>}
                                  </div>
                                  <p className="text-[10px] text-white/50 mb-3">{opt.desc}</p>
                                  <div className="flex gap-2">
                                    <button onClick={() => startRevealSequence(opt.value)} className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-widest text-white/80 hover:text-white hover:bg-white/10">Preview</button>
                                    <button
                                      onClick={() => setAsDefaultStyle(opt.value)}
                                      disabled={isDefault}
                                      className={`flex-1 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isDefault ? 'bg-white/5 border border-white/10 text-white/30 cursor-default' : 'bg-pink-500 text-black hover:bg-pink-400'}`}
                                    >
                                      {isDefault ? 'Default' : 'Set Default'}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="space-y-8">
                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-10 shadow-2xl">
                        <h4 className="text-2xl font-black text-white uppercase tracking-tighter flex items-center gap-3 mb-8">Broadcaster</h4>
                        <div className="space-y-6">
                          {/* Delivery mode toggle */}
                          <div>
                            <label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-3 block">Delivery Mode</label>
                            <div className="flex gap-2">
                              <button
                                onClick={() => setDeliveryMode("push")}
                                className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg border transition-all ${deliveryMode === "push" ? 'bg-pink-500 border-pink-500 text-black shadow-lg' : 'bg-white/5 border-white/10 text-white/40'}`}
                              >
                                Push Notification
                              </button>
                              <button
                                onClick={() => setDeliveryMode("inapp")}
                                className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg border transition-all ${deliveryMode === "inapp" ? 'bg-pink-500 border-pink-500 text-black shadow-lg' : 'bg-white/5 border-white/10 text-white/40'}`}
                              >
                                In-App Broadcast
                              </button>
                            </div>
                          </div>
                          <div><label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-3 block">Target</label><div className="flex gap-2">{(['all', 'unpaid'] as const).map(t => (
                            <button key={t} onClick={() => setBlastTarget(t)} className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg border transition-all ${blastTarget === t ? 'bg-pink-500 border-pink-500 text-black shadow-lg' : 'bg-white/5 border-white/10 text-white/40'}`}>{t}</button>
                          ))}<button disabled className="flex-1 py-2 text-[10px] font-black uppercase rounded-lg border bg-white/5 border-white/10 text-white/20 cursor-not-allowed">custom</button></div></div>
                          {/* Schedule mode */}
                          <div>
                            <label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-3 block">Schedule</label>
                            <div className="flex gap-2">
                              <button onClick={() => setScheduleMode("now")} className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg border transition-all ${scheduleMode === "now" ? 'bg-pink-500 border-pink-500 text-black shadow-lg' : 'bg-white/5 border-white/10 text-white/40'}`}>Send Now</button>
                              <button onClick={() => setScheduleMode("once")} className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg border transition-all ${scheduleMode === "once" ? 'bg-pink-500 border-pink-500 text-black shadow-lg' : 'bg-white/5 border-white/10 text-white/40'}`}>Schedule Once</button>
                              <button onClick={() => setScheduleMode("recurring")} className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg border transition-all ${scheduleMode === "recurring" ? 'bg-pink-500 border-pink-500 text-black shadow-lg' : 'bg-white/5 border-white/10 text-white/40'}`}>Recurring</button>
                            </div>
                          </div>
                          {/* Schedule inputs (UI only) */}
                          {scheduleMode === "once" && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <input type="date" className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white" value={scheduleOnceDate} onChange={(e) => setScheduleOnceDate(e.target.value)} />
                              <input type="time" className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white" value={scheduleOnceTime} onChange={(e) => setScheduleOnceTime(e.target.value)} />
                            </div>
                          )}
                          {scheduleMode === "recurring" && (
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                              <select className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white" value="weekly" disabled>
                                <option value="weekly">Weekly</option>
                              </select>
                              <select className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white" value={recurringDay} onChange={(e) => setRecurringDay(e.target.value)}>
                                {["Sat","Sun","Mon","Tue","Wed","Thu","Fri"].map(d => <option key={d} value={d}>{d}</option>)}
                              </select>
                              <input type="time" className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white" value={recurringTime} onChange={(e) => setRecurringTime(e.target.value)} />
                            </div>
                          )}
                          <div><label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-3 block">Payload</label><textarea value={blastMessage} onChange={(e) => setBlastMessage(e.target.value)} rows={5} placeholder="Message text..." className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-4 text-white text-sm outline-none focus:border-pink-500 transition-all resize-none" /></div>
                          <button
                            disabled={isTransmitting || !blastMessage}
                            onClick={async () => {
                              const title = "Announcement";
                              const body = blastMessage;

                              if (scheduleMode === "once") {
                                if (!scheduleOnceDate || !scheduleOnceTime) {
                                  showToast("error", "Pick a date and time for the scheduled send.");
                                  return;
                                }
                                const sendAt = new Date(`${scheduleOnceDate}T${scheduleOnceTime}`);
                                if (isNaN(sendAt.getTime()) || sendAt <= new Date()) {
                                  showToast("error", "Scheduled time must be in the future.");
                                  return;
                                }
                                setIsTransmitting(true);
                                try {
                                  const { error: insErr } = await supabase.from("scheduled_notifications").insert({
                                    title, body, target: blastTarget, delivery_mode: deliveryMode,
                                    send_at: sendAt.toISOString(), repeat_rule: null, active: true,
                                  });
                                  if (insErr) { showToast("error", "Failed to schedule: " + insErr.message); return; }
                                  await fetchScheduled();
                                  setBlastMessage('');
                                } finally { setIsTransmitting(false); }
                                return;
                              }

                              if (scheduleMode === "recurring") {
                                if (!recurringDay || !recurringTime) {
                                  showToast("error", "Pick a day and time for the recurring send.");
                                  return;
                                }
                                const dayIndexMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
                                const targetDay = dayIndexMap[recurringDay] ?? 6;
                                const [hour, minute] = recurringTime.split(":").map(Number);
                                const next = new Date();
                                next.setHours(hour ?? 0, minute ?? 0, 0, 0);
                                let diff = targetDay - next.getDay();
                                if (diff < 0 || (diff === 0 && next <= new Date())) diff += 7;
                                next.setDate(next.getDate() + diff);

                                setIsTransmitting(true);
                                try {
                                  const { error: insErr } = await supabase.from("scheduled_notifications").insert({
                                    title, body, target: blastTarget, delivery_mode: deliveryMode,
                                    send_at: next.toISOString(),
                                    repeat_rule: `weekly:${recurringDay}:${recurringTime}`,
                                    active: true,
                                  });
                                  if (insErr) { showToast("error", "Failed to schedule: " + insErr.message); return; }
                                  await fetchScheduled();
                                  setBlastMessage('');
                                } finally { setIsTransmitting(false); }
                                return;
                              }

                              // scheduleMode === "now"
                              setIsTransmitting(true);
                              try {
                                if (deliveryMode === "push" || deliveryMode === "both") {
                                  const ok = await fireRealPush(title, body, blastTarget);
                                  if (!ok) showToast("error", "Push broadcast failed. Check console for details.");
                                }
                                if (deliveryMode === "inapp" || deliveryMode === "both") {
                                  addInAppNotification(title, body, blastTarget, 'blast');
                                }
                                setBlastMessage('');
                              } finally { setIsTransmitting(false); }
                            }}
                            className="w-full py-5 bg-pink-500 text-black font-black uppercase text-xs tracking-widest rounded-2xl hover:bg-pink-400 transition-all disabled:opacity-30 shadow-xl shadow-pink-500/10"
                          >
                            {isTransmitting ? 'Sending…' : (scheduleMode === 'now' ? 'Send Broadcast' : 'Save Schedule')}
                          </button>
                          <button
                            onClick={async () => {
                              console.log("Test Push config", { deliveryMode, blastTarget, scheduleMode, scheduleOnceDate, scheduleOnceTime, recurringDay, recurringTime });
                              const res = await fetch("/.netlify/functions/push-broadcast", {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ title: "Test Push", body: "Hello from Netlify Function ✅" }),
                              });

                              const text = await res.text();
                              if (!res.ok) {
                                showToast("error", text);
                                return;
                              }
                              showToast("success", text);
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
                          <div>
                            <label className="text-[9px] font-black uppercase tracking-widest text-white/40 mb-1 block">Reveal style</label>
                            <select
                              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm"
                              value={recordRevealStyle}
                              onChange={(e) => setRecordRevealStyle(e.target.value as RevealStyle | '')}
                            >
                              <option value="">Use default ({REVEAL_STYLES.find((s) => s.value === revealDefaultStyle)?.label})</option>
                              {REVEAL_STYLES.map((s) => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                              ))}
                            </select>
                          </div>
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
                        <p className="text-sm font-black text-white/80">Balance: £{bankBalance}</p>
                      </div>
                      {/* DANGER ZONE — collapsed by default */}
                      <div className="bg-red-500/5 border border-red-500/20 rounded-[2.5rem] p-6 md:p-8 shadow-2xl">
                        <button
                          onClick={() => setDangerOpen((v) => !v)}
                          className="w-full flex items-center justify-between text-left"
                        >
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-red-400 mb-1">Danger Zone</p>
                            <h4 className="text-lg font-black text-white uppercase tracking-tighter">Hard Reset</h4>
                          </div>
                          <span className="text-white/40">{dangerOpen ? '▾' : '▸'}</span>
                        </button>
                        {dangerOpen && (
                          <div className="mt-6 space-y-3">
                            <p className="text-xs text-red-400 leading-relaxed">
                              This permanently clears all balls, all winners, and resets the bank to £0. Past ledger entries remain. This <strong>cannot</strong> be undone.
                            </p>
                            <input
                              type="password"
                              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white"
                              placeholder="Enter PIN"
                              value={resetPin}
                              onChange={(e) => setResetPin(e.target.value)}
                            />
                            <button
                              disabled={isResetting}
                              onClick={handleHardReset}
                              className="w-full py-3 bg-red-600 hover:bg-red-700 text-white font-black uppercase text-xs tracking-widest rounded-xl disabled:opacity-50"
                            >
                              {isResetting ? 'Resetting...' : 'Hard Reset'}
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-10 shadow-2xl">
                        <div>
                          <h3 className="text-lg font-bold mb-4">Scheduled Notifications</h3>

                          {scheduledNotifications.length === 0 && (
                            <p className="text-gray-400">No scheduled notifications.</p>
                          )}

                          {scheduledNotifications.map((item) => (
                            <div
                              key={item.id}
                              className="mb-4 p-4 rounded bg-black border border-gray-700"
                            >
                              <p className="font-semibold">{item.title}</p>
                              <p className="text-sm text-gray-400">{item.body}</p>
                              <p className="text-xs text-gray-500 mt-2">
                                Target: {item.target} | Mode: {item.delivery_mode}
                              </p>
                              {item.send_at && (
                                <p className="text-xs text-gray-500">
                                  Send At: {new Date(item.send_at).toLocaleString()}
                                </p>
                              )}
                              {item.repeat_rule && (
                                <p className="text-xs text-gray-500">
                                  Repeat: {item.repeat_rule}
                                </p>
                              )}
                              <button
                                onClick={() => deleteScheduled(item.id)}
                                className="mt-3 text-xs text-red-400 hover:text-red-300"
                              >
                                Delete
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                      {/* MEMBERS */}
                      <div className="bg-white/[0.03] border border-white/10 rounded-[2.5rem] p-6 md:p-8 shadow-2xl">
                        <h4 className="text-2xl font-black text-white uppercase tracking-tighter mb-6">Members</h4>
                        {membersWithStats.length === 0 ? (
                          <p className="text-sm text-white/40">No registered members yet.</p>
                        ) : (
                          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                            {membersWithStats.map((m: any) => (
                              <div key={m.id} className="flex items-center justify-between gap-3 bg-black/30 border border-white/5 rounded-2xl p-3">
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-black text-white truncate">{m.full_name || '—'}</p>
                                  <p className="text-[10px] uppercase font-bold text-white/40 truncate">{m.email}</p>
                                  <p className="text-[10px] font-bold text-pink-400 mt-1">
                                    {m.ballNumbers.length === 0
                                      ? 'No balls'
                                      : `${m.ballNumbers.length} ball${m.ballNumbers.length === 1 ? '' : 's'} · ${m.totalWeeks} week${m.totalWeeks === 1 ? '' : 's'} covered`}
                                  </p>
                                </div>
                                <button
                                  onClick={() => removeMember(m.id, m.full_name || m.email)}
                                  className="text-[10px] font-black uppercase text-red-400 hover:text-red-300 px-2 py-1"
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="bg-gradient-to-br from-pink-500 to-pink-600 rounded-[2.5rem] p-10 text-black shadow-2xl">
                         <div className="flex justify-between items-start mb-10"><div><p className="text-[10px] font-black uppercase tracking-widest opacity-60">Status</p><h4 className="text-4xl font-black tracking-tighter leading-none">{paidCount > 0 ? 'Active' : 'Growth'}</h4></div><div className="w-10 h-10 rounded-full bg-black/10 flex items-center justify-center"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg></div></div>
                         <div className="space-y-4">
                          <div className="flex justify-between text-xs font-bold border-b border-black/10 pb-2"><span>Paid Members</span><span>{paidCount}/59</span></div>
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
          <nav className="fixed bottom-0 left-0 w-full bg-[#020407]/95 backdrop-blur-3xl border-t border-white/10 pb-safe z-50">
            <div className="max-w-2xl mx-auto flex items-center justify-around px-4 sm:px-8 h-20 sm:h-24">
              {(['home', 'balls', 'winners', 'admin'] as Tab[]).map(t => {
                if (t === 'admin' && !isAdmin) return null;
                return (
                  <button key={t} onClick={() => setActiveTab(t)} className={`flex flex-col items-center gap-1.5 transition-all group ${activeTab === t ? 'scale-110' : 'opacity-50 hover:opacity-100'}`}>
                    <div className={`w-11 h-11 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center transition-all ${activeTab === t ? 'bg-pink-500 text-black shadow-[0_0_25px_rgba(236,72,153,0.3)]' : 'bg-white/5 text-white'}`}>
                      {t === 'home' && <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3" /></svg>}
                      {t === 'balls' && <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 6h16M4 12h16m-7 6h7" /></svg>}
                      {t === 'winners' && <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 3v4M3 5h4M6 17v4m-2-2h4" /></svg>}
                      {t === 'admin' && <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4" /></svg>}
                    </div>
                    <span className="text-[9px] sm:text-[8px] font-black uppercase tracking-widest text-white/40 group-hover:text-white transition-colors">{t}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          {showLedger && (
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="bg-neutral-900 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">

                <div className="flex justify-between items-center p-4 border-b border-neutral-800">
                  <h2 className="text-lg font-semibold">Ledger</h2>
                  <button
                    onClick={() => setShowLedger(false)}
                    className="text-neutral-400 hover:text-white"
                  >
                    Close
                  </button>
                </div>

                <div className="p-4 overflow-y-auto space-y-6">
                  {/* AUDIT PANEL */}
                  {(() => {
                    const driftBalls = bankBalance - expectedBankTotal;
                    const driftLedger = bankBalance - ledgerNet;
                    const driftClass = (n: number) =>
                      Math.abs(n) < 0.01 ? "text-green-400" : "text-red-400";
                    return (
                      <div className="bg-neutral-800/60 rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <p className="text-neutral-400 text-xs uppercase tracking-wider">Bank balance</p>
                          <p className="text-2xl font-bold">£{Number(bankBalance).toFixed(2)}</p>
                        </div>
                        <div>
                          <p className="text-neutral-400 text-xs uppercase tracking-wider">Expected (prepaid + rollover)</p>
                          <p className="text-2xl font-bold">£{Number(expectedBankTotal).toFixed(2)}</p>
                          <p className={`text-xs ${driftClass(driftBalls)}`}>
                            Δ £{driftBalls.toFixed(2)}
                          </p>
                        </div>
                        <div>
                          <p className="text-neutral-400 text-xs uppercase tracking-wider">Ledger net</p>
                          <p className="text-2xl font-bold">£{Number(ledgerNet).toFixed(2)}</p>
                          <p className={`text-xs ${driftClass(driftLedger)}`}>
                            Δ £{driftLedger.toFixed(2)}
                          </p>
                        </div>
                        <div>
                          <p className="text-neutral-400 text-xs uppercase tracking-wider">Open rollover</p>
                          <p className="text-2xl font-bold">£{Number(totalRollover).toFixed(2)}</p>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ADD MANUAL ENTRY */}
                  {isAdmin && (
                    <div className="bg-neutral-800/40 rounded-xl p-4">
                      <p className="text-sm font-semibold mb-3">Add entry</p>
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                        <select
                          className="md:col-span-3 bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                          value={newEntryType}
                          onChange={(e) => setNewEntryType(e.target.value as any)}
                        >
                          <option value="deposit">Deposit</option>
                          <option value="paid_win">Paid win (out)</option>
                          <option value="charity">Charity (out)</option>
                          <option value="adjustment">Adjustment (signed)</option>
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="Amount"
                          className="md:col-span-2 bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                          value={newEntryAmount}
                          onChange={(e) => setNewEntryAmount(e.target.value)}
                        />
                        <input
                          type="text"
                          placeholder="Notes (optional)"
                          className="md:col-span-5 bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                          value={newEntryNotes}
                          onChange={(e) => setNewEntryNotes(e.target.value)}
                        />
                        <button
                          disabled={ledgerBusy}
                          onClick={addManualEntry}
                          className="md:col-span-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-black font-semibold rounded px-3 py-2 text-sm"
                        >
                          Add
                        </button>
                      </div>
                      <p className="text-xs text-neutral-500 mt-2">
                        Adjustments accept negative amounts. All other types are stored as positive — the type determines the sign on the bank.
                      </p>
                    </div>
                  )}

                  {/* TABLE */}
                  {ledgerWithRunning.length === 0 ? (
                    <p className="text-neutral-400">No ledger entries found.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-neutral-400 border-b border-neutral-800">
                          <tr>
                            <th className="text-left py-2 pr-3">Date</th>
                            <th className="text-left py-2 pr-3">Type</th>
                            <th className="text-right py-2 pr-3">Amount</th>
                            <th className="text-right py-2 pr-3">Running</th>
                            <th className="text-left py-2 pr-3">Reference</th>
                            <th className="text-left py-2 pr-3">Notes</th>
                            {isAdmin && <th className="py-2"></th>}
                          </tr>
                        </thead>
                        <tbody>
                          {ledgerWithRunning.map((row) => {
                            const effect = ledgerEffectOnBank(row.type, row.amount);
                            const sign = effect > 0 ? "+" : effect < 0 ? "−" : "";
                            const amtClass = effect > 0 ? "text-green-400" : effect < 0 ? "text-red-400" : "text-neutral-300";
                            return (
                              <tr key={row.id} className="border-b border-neutral-800/60 hover:bg-neutral-800/30">
                                <td className="py-2 pr-3 whitespace-nowrap text-neutral-300">
                                  {new Date(row.created_at).toLocaleString()}
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap">{row.type}</td>
                                <td className={`py-2 pr-3 text-right whitespace-nowrap font-mono ${amtClass}`}>
                                  {sign}£{Math.abs(Number(row.amount)).toFixed(2)}
                                </td>
                                <td className="py-2 pr-3 text-right whitespace-nowrap font-mono text-neutral-400">
                                  £{Number(row.runningBalance).toFixed(2)}
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap text-neutral-300">{row.reference}</td>
                                <td className="py-2 pr-3 text-neutral-400">{row.notes ?? ""}</td>
                                {isAdmin && (
                                  <td className="py-2 text-right">
                                    <button
                                      disabled={ledgerBusy}
                                      onClick={() => deleteLedgerEntry(row)}
                                      className="text-red-400 hover:text-red-300 disabled:opacity-40 text-xs"
                                    >
                                      Delete
                                    </button>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

              </div>
            </div>
          )}

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
                    <select
                      value={selectedMemberId}
                      onChange={(e) => setSelectedMemberId(e.target.value)}
                      className="w-full mt-2 p-2 rounded bg-black border border-gray-600 text-white"
                    >
                      <option value="">Optional: Link to registered member</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.full_name} ({member.email})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleResetToVacant}
                      className="w-full py-3 rounded-xl bg-red-600 hover:bg-red-700 transition text-white font-semibold"
                    >
                      Reset to Vacant
                    </button>
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
                        if (!ball?.owner) return 'Vacant — full pot will roll to next draw';
                        return isBallPaidForDraw(ball)
                          ? `Paid up — ${ball.owner} will receive the prize`
                          : `Unpaid — ${ball.owner} forfeits, full pot rolls over`;
                      })()}
                    </p>
                    <select
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm"
                      value={selectedResultBall ?? ''}
                      onChange={(e) => setSelectedResultBall(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">Select ball</option>
                      {balls.map(b => {
                        const marker = !b.owner ? '○' : isBallPaidForDraw(b) ? '✓' : '✗';
                        const label = b.owner ? `${b.owner}` : 'Vacant';
                        return <option key={b.number} value={b.number}>{marker} {b.number} — {label}</option>;
                      })}
                    </select>
                    <p className="text-[10px] text-white/30 leading-snug">
                      ✓ paid · ✗ unpaid · ○ vacant
                    </p>
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
              <LotteryBall number={selectedBallNum} className="w-40 h-40 sm:w-56 sm:h-56 mx-auto mb-6" />
              {selectedBall && (() => {
                const weeks = weeksCoveredFor(selectedBall);
                const isPaid = weeks > 0;
                const winsHere = winnerRows.filter((r: any) => Number(r.winning_number) === selectedBallNum && r.winner_name);
                return (
                  <div className="space-y-4 text-white">
                    <p className="text-2xl font-black tracking-tighter">
                      {selectedBall.owner ?? `Vacant Ball #${selectedBallNum}`}
                    </p>
                    <div className={`inline-flex items-center gap-2 text-xs font-black uppercase tracking-widest px-3 py-1 rounded-full ${isPaid ? 'bg-green-500/10 text-green-400 border border-green-500/30' : 'bg-red-500/10 text-red-400 border border-red-500/30'}`}>
                      {isPaid
                        ? `Covered · ${weeks} week${weeks === 1 ? '' : 's'} left`
                        : selectedBall.owner ? 'Not covered' : 'Open for assignment'}
                    </div>
                    {isPaid && (
                      <p className="text-xs text-white/50">Paid through {formatPaidUntil(selectedBall.paidUntil)}</p>
                    )}
                    {winsHere.length > 0 && (
                      <div className="mt-6 pt-6 border-t border-white/10 text-left">
                        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-pink-400 mb-3">
                          Win history · {winsHere.length} time{winsHere.length === 1 ? '' : 's'}
                        </p>
                        <ul className="space-y-1.5 text-xs">
                          {winsHere.slice(0, 5).map((r: any) => (
                            <li key={r.id} className="flex justify-between text-white/70">
                              <span>{r.draw_date}</span>
                              <span className="text-white/90">{r.winner_name} · £{r.amount_won}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

          {/* INBOX */}
          {showInbox && (
            <div className="fixed inset-0 z-[200] flex flex-col bg-[#020407]">
              <header className="p-6 sm:p-8 flex items-center justify-between border-b border-white/10 gap-3">
                <h3 className="text-2xl sm:text-3xl font-black text-white uppercase">Notifications</h3>
                <div className="flex items-center gap-3">
                  {notifications.length > 0 && (
                    <button
                      onClick={clearAllNotifications}
                      className="text-[10px] font-black uppercase tracking-widest text-white/40 hover:text-red-400"
                    >
                      Clear all
                    </button>
                  )}
                  <button
                    onClick={() => setShowInbox(false)}
                    className="text-white/40 hover:text-white text-xl"
                  >
                    ✕
                  </button>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto p-4 sm:p-8 space-y-3">
                {notifications.length === 0 ? (
                  <div className="text-center py-12 text-white/40">
                    <p className="font-black uppercase tracking-widest mb-2 text-xs">No alerts</p>
                    <p className="text-xs text-white/30">In-app notifications from admin will appear here.</p>
                  </div>
                ) : (
                  notifications.map((n) => (
                    <div key={n.id} className="bg-white/5 border border-white/10 p-5 rounded-2xl relative group">
                      <button
                        onClick={() => dismissNotification(n.id)}
                        aria-label="Dismiss"
                        className="absolute top-3 right-3 w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 text-white/40 hover:text-white text-sm flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity"
                      >
                        ✕
                      </button>
                      <div className="pr-8">
                        <div className="flex items-baseline justify-between gap-2 mb-1">
                          <h5 className="font-black text-white">{n.title}</h5>
                          <span className="text-[10px] font-bold uppercase text-white/30 flex-shrink-0">{n.timestamp}</span>
                        </div>
                        <p className="text-white/60 text-sm">{n.body}</p>
                      </div>
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
          Full Name
        </label>
        <input
          name="fullName"
          required
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white outline-none focus:border-pink-500 transition-all"
          placeholder="Your name"
        />
      </div>
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
