// The three operations that move money: recording a payment, recording a result, and
// undoing a result. They live here, in one place, so that:
//   - the live app runs them on the server (netlify/functions/admin-action.ts), where a
//     phone losing signal halfway can't leave the books half-written, and
//   - the local demo runs the very same code against its in-memory data.
// `db` is a Supabase client (or the demo stand-in). Every function throws an Error with a
// plain-English message if it cannot finish.

type Db = any;

const PRICE_PER_WEEK = 2;
export const UNDO_WINDOW_MINUTES = 30;

/* ------------------------------ dates ------------------------------ */
// Draws are Saturday 8pm UK time. The server runs in UTC and phones run in UK time, so all
// date maths goes through these helpers rather than local-time Date methods.

const londonParts = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') };
};

/** The UK calendar date of an instant, as YYYY-MM-DD. */
export const londonDate = (iso: string | Date): string => {
  const p = londonParts(typeof iso === 'string' ? new Date(iso) : iso);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

/** 8pm UK time on the given YYYY-MM-DD, as a Date. */
export const eightPmLondon = (dateStr: string): Date => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 20, 0, 0, 0));
  const offsetHours = londonParts(guess).h - 20; // 0 in winter, 1 in summer
  return new Date(guess.getTime() - offsetHours * 3600000);
};

export const addDays = (dateStr: string, days: number): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days, 12));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

/** True when a ball's paid-up-to date covers the draw on drawDate. */
const coversDraw = (ball: any, drawDate: string) => !!ball?.paidUntil && londonDate(ball.paidUntil) >= drawDate;

/* ------------------------------ loading ------------------------------ */
const must = <T,>(res: { data: T; error: any }, what: string): T => {
  if (res.error || res.data == null) throw new Error(`Couldn't ${what}. Nothing was changed.`);
  return res.data;
};

const loadBalls = async (db: Db) => {
  const row: any = must(await db.from('bonus_ball_data').select('id, state').single(), 'load the balls');
  const balls = row?.state?.balls;
  if (!Array.isArray(balls) || balls.length === 0) throw new Error("Couldn't load the balls. Nothing was changed.");
  return { rowId: row.id, balls: balls as any[] };
};

const loadOpenDraw = async (db: Db) =>
  must<any>(await db.from('bonus_ball_winners').select('*').eq('status', 'open').single(), 'find the open draw');

const loadBank = async (db: Db): Promise<number> => {
  const row: any = must(await db.from('bonus_ball_bank').select('balance').eq('id', 1).single(), 'read the bank');
  return Number(row.balance) || 0;
};

const saveBalls = (db: Db, rowId: any, balls: any[]) =>
  db.from('bonus_ball_data').update({ state: { balls } }).eq('id', rowId);

const snapshot = async (db: Db) => {
  const [{ balls }, bank, open, winners] = await Promise.all([
    loadBalls(db),
    loadBank(db),
    loadOpenDraw(db),
    db.from('bonus_ball_winners').select('*').eq('status', 'completed').order('draw_date', { ascending: false }),
  ]);
  return { balls, bankBalance: bank, drawDate: open.draw_date as string, rollover: Number(open.rollover_amount) || 0, winners: (winners.data ?? []) as any[] };
};

/* ------------------------------ payment ------------------------------ */
export const recordPayment = async (db: Db, input: { ballNum: number; weeks: number; applyToAll: boolean }) => {
  const weeks = Math.floor(Number(input.weeks));
  const ballNum = Number(input.ballNum);
  if (!ballNum || !weeks || weeks < 1 || weeks > 520) throw new Error('Enter a number of weeks, 1 or more.');

  const { rowId, balls } = await loadBalls(db);
  const open = await loadOpenDraw(db);
  const drawDate: string = open.draw_date;
  const target = balls.find((b) => b.number === ballNum);
  if (!target) throw new Error(`Ball ${ballNum} doesn't exist.`);
  if (!target.owner) throw new Error(`Ball ${ballNum} has no owner, so it can't be paid for.`);

  const affected = input.applyToAll ? balls.filter((b) => b.owner === target.owner).map((b) => b.number) : [ballNum];
  const updated = balls.map((b) => {
    if (!affected.includes(b.number)) return b;
    // Already in for the upcoming draw: add the weeks on the end. Otherwise the first
    // week pays for the upcoming draw itself.
    const covered = coversDraw(b, drawDate);
    const from = covered ? londonDate(b.paidUntil) : drawDate;
    const upTo = addDays(from, 7 * (covered ? weeks : weeks - 1));
    return { ...b, paidUntil: eightPmLondon(upTo).toISOString() };
  });
  const amount = weeks * PRICE_PER_WEEK * affected.length;

  const bankBefore = await loadBank(db);
  const ballsRes = await saveBalls(db, rowId, updated);
  if (ballsRes.error) throw new Error("Payment didn't save. Nothing was changed.");

  const bankRes = await db.from('bonus_ball_bank').update({ balance: bankBefore + amount }).eq('id', 1);
  if (bankRes.error) {
    await saveBalls(db, rowId, balls); // put the balls back so the books still agree
    throw new Error("Payment didn't save: the bank couldn't be updated. Nothing was changed.");
  }

  const ledgerRes = await db.from('bonus_ball_ledger').insert([{
    type: 'deposit', amount, reference: 'Ball payment',
    notes: `Ball${affected.length > 1 ? 's' : ''} ${affected.join(', ')} (${target.owner}), ${weeks} week${weeks === 1 ? '' : 's'}`,
  }]);
  if (ledgerRes.error) {
    await db.from('bonus_ball_bank').update({ balance: bankBefore }).eq('id', 1);
    await saveBalls(db, rowId, balls);
    throw new Error("Payment didn't save: the ledger couldn't be written. Nothing was changed.");
  }

  const paidUntil = updated.find((b) => b.number === ballNum)?.paidUntil as string;
  return { ...(await snapshot(db)), summary: { amount, numbers: affected, owner: target.owner as string, paidUntil } };
};

/* ------------------------------ result ------------------------------ */
export const recordResult = async (db: Db, input: { ballNum: number; revealStyle?: string | null }) => {
  const ballNum = Number(input.ballNum);
  if (!ballNum || ballNum < 1 || ballNum > 59) throw new Error('Pick a ball from 1 to 59.');

  const { balls } = await loadBalls(db);
  const open = await loadOpenDraw(db);
  const drawDate: string = open.draw_date;
  const rolloverIn = Number(open.rollover_amount) || 0;
  const ball = balls.find((b) => b.number === ballNum);
  const paidWinner = !!ball?.owner && coversDraw(ball, drawDate);
  const paidPot = balls.filter((b) => coversDraw(b, drawDate)).length * PRICE_PER_WEEK;
  const amountWon = paidWinner ? paidPot + rolloverIn : 0;
  const rolloverOut = paidWinner ? 0 : rolloverIn + paidPot;
  const winnerName: string | null = ball?.owner ?? null;
  const nextDate = addDays(drawDate, 7);

  const payload: Record<string, any> = {
    status: 'completed', winning_number: ballNum, winner_name: winnerName, amount_won: amountWon,
    rollover_amount: rolloverOut, completed_at: new Date().toISOString(), reveal_style: input.revealStyle || null,
  };
  let upd = await db.from('bonus_ball_winners').update(payload).eq('id', open.id);
  if (upd.error && /reveal_style/i.test(upd.error.message || '')) {
    delete payload.reveal_style; // older database without the column, or a style it doesn't allow
    upd = await db.from('bonus_ball_winners').update(payload).eq('id', open.id);
  }
  if (upd.error) throw new Error("Couldn't save the result. Nothing was changed.");

  const next = await db.from('bonus_ball_winners').insert([{
    draw_date: nextDate, draw_timestamp: eightPmLondon(nextDate).toISOString(), status: 'open', rollover_amount: rolloverOut,
  }]);
  if (next.error) {
    // Put this draw back to open so the app isn't left with no draw to pay into.
    await db.from('bonus_ball_winners').update({
      status: 'open', winning_number: open.winning_number ?? null, winner_name: open.winner_name ?? null,
      amount_won: open.amount_won ?? null, rollover_amount: rolloverIn, completed_at: open.completed_at ?? null,
    }).eq('id', open.id);
    throw new Error("Couldn't save the result: next week's draw wasn't created. Nothing was changed.");
  }

  let warning = '';
  if (paidWinner) {
    const bank = await loadBank(db);
    const bankRes = await db.from('bonus_ball_bank').update({ balance: bank - amountWon }).eq('id', 1);
    if (bankRes.error) warning = `Result saved, but the bank wasn't reduced by £${amountWon}. Add a "Prize paid out" entry by hand.`;
    else {
      const led = await db.from('bonus_ball_ledger').insert([{
        type: 'paid_win', amount: amountWon, reference: `Draw ${drawDate}`, notes: `Paid winner - Ball ${ballNum}`,
      }]);
      if (led.error) warning = `Result saved and the bank reduced, but the ledger line for £${amountWon} is missing.`;
    }
  }

  // A line in the family chat. The chat table is optional, so a failure here is ignored.
  try {
    await db.from('bonus_ball_chat').insert([{
      user_id: null, name: 'Bonus Ball', kind: 'system',
      body: `Saturday's ball is in for ${drawDate}. Open the app to see it.`,
    }]);
  } catch { /* chat not set up */ }

  return { ...(await snapshot(db)), summary: { ballNum, paidWinner, winnerName, amountWon, rolloverOut, drawDate }, warning };
};

/* ------------------------------ undo ------------------------------ */
/** Says whether the latest result can still be undone, and why not if it can't. */
export const undoStatus = async (db: Db) => {
  const done = await db.from('bonus_ball_winners').select('*').eq('status', 'completed').order('draw_date', { ascending: false }).limit(1);
  const last: any = done.data?.[0];
  if (!last || !last.completed_at) return { ok: false as const, reason: 'There is no result to undo.' };
  const ageMin = (Date.now() - new Date(last.completed_at).getTime()) / 60000;
  if (ageMin > UNDO_WINDOW_MINUTES) return { ok: false as const, reason: `Results can only be undone for ${UNDO_WINDOW_MINUTES} minutes.` };
  const later = await db.from('bonus_ball_ledger').select('id').eq('type', 'deposit').gt('created_at', last.completed_at).limit(1);
  if ((later.data ?? []).length > 0) return { ok: false as const, reason: 'A payment has been recorded since, so this result can no longer be undone.' };
  return { ok: true as const, last, minutesLeft: Math.max(1, Math.ceil(UNDO_WINDOW_MINUTES - ageMin)) };
};

export const undoResult = async (db: Db) => {
  const status = await undoStatus(db);
  if (!status.ok) throw new Error(status.reason);
  const last = status.last;
  const { balls } = await loadBalls(db);
  const open = await loadOpenDraw(db);
  if (open.draw_date !== addDays(last.draw_date, 7)) throw new Error("The draws don't line up, so this can't be undone automatically. Nothing was changed.");

  const paidPot = balls.filter((b) => coversDraw(b, last.draw_date)).length * PRICE_PER_WEEK;
  const amountWon = Number(last.amount_won) || 0;
  const paidWinner = !!last.winner_name && amountWon > 0;
  const rolloverIn = paidWinner ? amountWon - paidPot : (Number(last.rollover_amount) || 0) - paidPot;
  if (rolloverIn < 0) throw new Error("The amounts don't add up, so this can't be undone automatically. Nothing was changed.");

  const del = await db.from('bonus_ball_winners').delete().eq('id', open.id);
  if (del.error) throw new Error("Couldn't undo the result. Nothing was changed.");
  // Reuse the blank values of the row we just removed, so the reopened draw looks exactly
  // like any other open draw whatever the table's defaults are.
  const blank: Record<string, any> = {
    status: 'open', winning_number: open.winning_number ?? null, winner_name: open.winner_name ?? null,
    amount_won: open.amount_won ?? null, rollover_amount: rolloverIn, completed_at: open.completed_at ?? null,
  };
  if ('reveal_style' in last) blank.reveal_style = open.reveal_style ?? null;
  const reopen = await db.from('bonus_ball_winners').update(blank).eq('id', last.id);
  if (reopen.error) throw new Error('The undo only half finished. Check the draws in Supabase before doing anything else.');

  if (paidWinner) {
    const bank = await loadBank(db);
    await db.from('bonus_ball_bank').update({ balance: bank + amountWon }).eq('id', 1);
    const led = await db.from('bonus_ball_ledger').select('id').eq('type', 'paid_win').eq('reference', `Draw ${last.draw_date}`).order('created_at', { ascending: false }).limit(1);
    const ledId = led.data?.[0]?.id;
    if (ledId) await db.from('bonus_ball_ledger').delete().eq('id', ledId);
  }

  return { ...(await snapshot(db)), summary: { ballNum: Number(last.winning_number), drawDate: last.draw_date as string } };
};
