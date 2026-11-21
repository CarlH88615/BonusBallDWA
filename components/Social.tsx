import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LotteryBall } from './LotteryBall';

// The sociable bits of the board: bragging rights, reactions on the last draw, and the
// family chat. Reactions and chat need their own database tables; when those are missing
// the components simply don't appear.

const dim = 'text-[#5a6270]';
const card = 'bg-white rounded-3xl p-4 sm:p-5';

/* ------------------------------ Bragging rights ------------------------------ */
interface StatsProps {
  winners: any[]; // completed draws the viewer is allowed to see, newest first
  balls: any[];
  myNumbers: number[];
}

const dayLabel = (dateStr: string) => {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return String(dateStr);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const Stats: React.FC<StatsProps> = ({ winners, balls, myNumbers }) => {
  const stats = useMemo(() => {
    const draws = winners.filter((r) => r.winning_number);
    if (draws.length < 3) return null;

    const byBall = new Map<number, number>();
    draws.forEach((r) => byBall.set(Number(r.winning_number), (byBall.get(Number(r.winning_number)) ?? 0) + 1));
    const luckiest = [...byBall.entries()].sort((a, b) => b[1] - a[1])[0];

    const paid = draws.filter((r) => r.winner_name && Number(r.amount_won) > 0);
    const byName = new Map<string, { wins: number; total: number }>();
    paid.forEach((r) => {
      const cur = byName.get(r.winner_name) ?? { wins: 0, total: 0 };
      byName.set(r.winner_name, { wins: cur.wins + 1, total: cur.total + Number(r.amount_won) });
    });
    const mostWins = [...byName.entries()].sort((a, b) => b[1].wins - a[1].wins || b[1].total - a[1].total)[0];
    const biggest = [...paid].sort((a, b) => Number(b.amount_won) - Number(a.amount_won))[0];

    // Longest wait: of the people who own a ball today, who has gone most draws without a win.
    const owners = [...new Set(balls.map((b) => b?.owner).filter(Boolean))] as string[];
    let longest: { name: string; draws: number; never: boolean } | null = null;
    owners.forEach((name) => {
      const idx = draws.findIndex((r) => r.winner_name === name && Number(r.amount_won) > 0);
      const waited = idx === -1 ? draws.length : idx;
      if (!longest || waited > longest.draws) longest = { name, draws: waited, never: idx === -1 };
    });

    const drawn = new Set(byBall.keys());
    const never = Array.from({ length: 59 }, (_, i) => i + 1).filter((n) => !drawn.has(n));
    const mineNever = myNumbers.filter((n) => never.includes(n));
    return { count: draws.length, luckiest, mostWins, biggest, longest: longest as { name: string; draws: number; never: boolean } | null, never, mineNever };
  }, [winners, balls, myNumbers]);

  if (!stats) return null;
  const Row = ({ icon, title, sub, value }: { icon: React.ReactNode; title: string; sub: string; value: string }) => (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 flex-none">{icon}</div>
      <div className="flex-1 min-w-0"><p className="font-bold">{title}</p><p className={`text-xs ${dim}`}>{sub}</p></div>
      <p className="font-extrabold tabular-nums">{value}</p>
    </div>
  );
  const badge = (text: string, cls: string) => <div className={`w-10 h-10 rounded-full flex items-center justify-center font-extrabold ${cls}`}>{text}</div>;

  return (
    <section className={card + ' space-y-3'}>
      <div className="flex items-baseline justify-between">
        <h2 className="font-extrabold">Bragging rights</h2>
        <span className={`text-sm font-semibold ${dim}`}>{stats.count} draws so far</span>
      </div>
      {stats.luckiest && stats.luckiest[1] > 1 && (
        <Row icon={<LotteryBall number={stats.luckiest[0]} hideShadow className="w-full h-full" />} title="Luckiest ball" sub={`${stats.luckiest[0]} has come up ${stats.luckiest[1]} times`} value={`×${stats.luckiest[1]}`} />
      )}
      {stats.mostWins && (
        <Row icon={badge(stats.mostWins[0].charAt(0).toUpperCase(), 'bg-[#ffd100] text-[#14161c]')} title="Most wins" sub={`${stats.mostWins[0]}, £${stats.mostWins[1].total} in total`} value={String(stats.mostWins[1].wins)} />
      )}
      {stats.longest && stats.longest.draws > 0 && (
        <Row icon={badge(stats.longest.name.charAt(0).toUpperCase(), 'bg-[#e9ecf2] text-[#14161c]')} title="Longest wait" sub={stats.longest.never ? `${stats.longest.name} hasn't won in ${stats.longest.draws} draws` : `${stats.longest.name}, ${stats.longest.draws} draws since a win`} value={String(stats.longest.draws)} />
      )}
      {stats.biggest && (
        <Row icon={badge('£', 'bg-[#14161c] text-white')} title="Biggest pot" sub={`${stats.biggest.winner_name}, ${dayLabel(stats.biggest.draw_date)}`} value={`£${stats.biggest.amount_won}`} />
      )}
      <Row
        icon={<div className="w-10 h-10 rounded-full border-2 border-dotted border-[#9aa3b2] flex items-center justify-center font-extrabold text-[#5a6270]">?</div>}
        title="Never drawn"
        sub={stats.mineNever.length ? `${stats.never.length} balls, including your ${stats.mineNever.join(' and ')}` : `${stats.never.length} balls have never come up`}
        value={String(stats.never.length)}
      />
    </section>
  );
};

/* ------------------------------ Reactions ------------------------------ */
const EMOJI = ['😂', '🎉', '😭', '😡', '👏', '🤞'];

interface ReactionsProps {
  supabase: any;
  drawId: string | number;
  userId: string | null;
}

export const Reactions: React.FC<ReactionsProps> = ({ supabase, drawId, userId }) => {
  const [rows, setRows] = useState<any[] | null>(null); // null = not loaded or table missing
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data, error } = await supabase.from('bonus_ball_reactions').select('*').eq('draw_id', String(drawId));
    setRows(error ? null : (data ?? []));
  };
  useEffect(() => { load(); }, [drawId]);

  if (!rows || !userId) return null;
  const toggle = async (emoji: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const mine = rows.find((r) => r.emoji === emoji && r.user_id === userId);
      if (mine) await supabase.from('bonus_ball_reactions').delete().eq('id', mine.id);
      else await supabase.from('bonus_ball_reactions').insert([{ draw_id: String(drawId), user_id: userId, emoji }]);
      await load();
    } finally { setBusy(false); }
  };

  const people = new Set(rows.map((r) => r.user_id)).size;
  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 flex-wrap">
        {EMOJI.map((emoji) => {
          const count = rows.filter((r) => r.emoji === emoji).length;
          const mine = rows.some((r) => r.emoji === emoji && r.user_id === userId);
          return (
            <button
              key={emoji}
              aria-pressed={mine}
              aria-label={`React ${emoji}`}
              onClick={() => toggle(emoji)}
              className={`rounded-full px-2.5 py-1 text-sm font-extrabold border transition active:scale-90 ${mine ? 'border-[#14161c] bg-white' : 'border-[#dbe0e8] bg-[#f1f3f7]'}`}
            >
              {emoji}{count > 0 && <span className="ml-1 tabular-nums">{count}</span>}
            </button>
          );
        })}
      </div>
      {people > 0 && <p className={`text-xs ${dim}`}>{people} {people === 1 ? 'person has' : 'people have'} reacted</p>}
    </div>
  );
};

/* ------------------------------ Family chat ------------------------------ */
interface ChatProps {
  messages: any[]; // oldest first
  userId: string | null;
  isAdmin: boolean;
  bg: string;
  fg: string;
  onSend: (body: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export const Chat: React.FC<ChatProps> = ({ messages, userId, isAdmin, bg, fg, onSend, onDelete, onClose }) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [armed, setArmed] = useState<string | null>(null); // message waiting for a second tap to delete
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const ok = await onSend(body);
    setSending(false);
    if (ok) setText('');
  };

  const timeLabel = (iso: string) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  return (
    <div className="fixed inset-0 z-[300] bg-[#f1f3f7] flex flex-col">
      <div className="flex-none" style={{ background: bg, color: fg }}>
        <div className="max-w-lg mx-auto flex items-center gap-3 px-4 py-3.5">
          <button onClick={onClose} aria-label="Back to the board" className="w-10 h-10 rounded-full bg-black/15 text-xl font-bold">‹</button>
          <h2 className="flex-1 text-lg font-extrabold">Family chat</h2>
        </div>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-4 py-4 flex flex-col gap-2.5">
          {messages.length === 0 && <p className={`text-center py-10 ${dim}`}>Nobody has said anything yet. Go first.</p>}
          {messages.map((m) => {
            if (m.kind === 'system') {
              return <p key={m.id} className={`self-center text-xs font-semibold bg-[#e9ecf2] rounded-full px-3 py-1 ${dim}`}>{m.body}</p>;
            }
            const mine = m.user_id === userId;
            const canDelete = mine || isAdmin;
            return (
              <div key={m.id} className={`max-w-[82%] ${mine ? 'self-end' : 'self-start'}`}>
                <div
                  className={`px-3.5 py-2 text-[15px] leading-snug break-words ${mine ? 'rounded-[18px_18px_4px_18px]' : 'bg-white rounded-[18px_18px_18px_4px]'}`}
                  style={mine ? { background: bg, color: fg } : undefined}
                >
                  {!mine && <p className={`text-xs font-extrabold ${dim}`}>{m.name}</p>}
                  {m.body}
                </div>
                <p className={`text-[11px] mt-0.5 ${dim} ${mine ? 'text-right' : ''}`}>
                  {timeLabel(m.created_at)}
                  {canDelete && (
                    <button
                      className="ml-2 font-bold underline"
                      onClick={() => { if (armed === m.id) { onDelete(m.id); setArmed(null); } else setArmed(m.id); }}
                    >
                      {armed === m.id ? 'Tap again to delete' : 'Delete'}
                    </button>
                  )}
                </p>
              </div>
            );
          })}
        </div>
      </div>
      <form onSubmit={submit} className="flex-none bg-white border-t border-[#dbe0e8]">
        <div className="max-w-lg mx-auto flex gap-2 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <input
            id="chat-message"
            aria-label="Message"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 500))}
            placeholder="Message"
            autoComplete="off"
            className="flex-1 min-w-0 bg-[#f1f3f7] border border-[#dbe0e8] rounded-full px-4 py-2.5 text-base outline-none focus:border-[#14161c]"
          />
          <button type="submit" disabled={!text.trim() || sending} className="rounded-full px-5 font-extrabold bg-[#14161c] text-white disabled:opacity-40">Send</button>
        </div>
      </form>
    </div>
  );
};
