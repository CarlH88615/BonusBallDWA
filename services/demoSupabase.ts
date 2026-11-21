// Demo data for local development only. Open http://localhost:<port>/?demo to try the
// app as a family member, or ?demo=admin to try the admin. Nothing here touches the real
// database: every read and write stays in this tab's memory and resets on reload.
// services/supabase.ts only uses this when Vite is running in dev mode.

export const DEMO_ADMIN_EMAIL = 'demo-admin@example.test';
const DEMO_MEMBER_EMAIL = 'sam@example.test';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const nextSaturday8pm = () => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0, 0, 0);
  if (!(d.getDay() === 6 && now < d)) d.setDate(d.getDate() + (d.getDay() === 6 ? 7 : (6 - d.getDay() + 7) % 7));
  return d;
};
const weeksFrom = (d: Date, w: number) => new Date(d.getTime() + w * 7 * 24 * 60 * 60 * 1000);

const buildTables = (role: 'member' | 'admin') => {
  const draw = nextSaturday8pm();
  const names = ['Nana Pat', 'Dave M', 'Kev', 'Lisa', 'Uncle Rob', 'Mo', 'Chloe', 'Tina', 'Gaz', 'Shaz', 'Big Al'];
  const free = new Set([5, 15, 25, 35, 45, 55, 9, 27, 49]);
  const unpaid = new Set([12, 31, 42, 56]);
  const myEmail = role === 'admin' ? DEMO_ADMIN_EMAIL : DEMO_MEMBER_EMAIL;
  const balls = Array.from({ length: 59 }, (_, i) => {
    const number = i + 1;
    if (free.has(number)) return { number, owner: null, ownerName: null, userId: null, email: null, paidUntil: null };
    const mine = number === 17 || number === 42;
    const owner = mine ? 'Sam' : number === 24 ? 'Auntie Jean' : names[(number * 7) % names.length];
    const paidUntil = unpaid.has(number) ? weeksFrom(draw, -1).toISOString() : weeksFrom(draw, number % 4).toISOString();
    return { number, owner, ownerName: owner, userId: mine ? 'demo-user' : null, email: mine ? myEmail : null, paidUntil };
  });
  const prepaid = balls.reduce((sum, b) => {
    if (!b.paidUntil || new Date(b.paidUntil) < draw) return sum;
    return sum + (Math.floor((new Date(b.paidUntil).getTime() - draw.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1) * 2;
  }, 0);
  const rollover = 28;
  const past = [
    { n: 24, w: 'Auntie Jean', a: 58 },
    { n: 9, w: null, a: 0 },
    { n: 51, w: 'Kev', a: 112 },
    { n: 36, w: 'Nana Pat', a: 38 },
    { n: 19, w: 'Dave M', a: 44 },
    { n: 8, w: 'Tina', a: 40 },
  ];
  return {
    bonus_ball_data: [{ id: 1, state: { balls } }],
    bonus_ball_bank: [{ id: 1, balance: prepaid + rollover }],
    bonus_ball_ledger: [
      { id: 'l1', type: 'deposit', amount: prepaid + rollover, reference: 'Opening balance', notes: 'Demo data', created_at: weeksFrom(draw, -2).toISOString() },
    ],
    bonus_ball_winners: [
      { id: 'open', draw_date: ymd(draw), draw_timestamp: draw.toISOString(), status: 'open', rollover_amount: rollover },
      ...past.map((p, i) => ({
        id: `w${i}`, draw_date: ymd(weeksFrom(draw, -(i + 1))), status: 'completed', winning_number: p.n, winner_name: p.w,
        amount_won: p.a, rollover_amount: p.w ? 0 : 28, reveal_style: 'scratch', completed_at: weeksFrom(draw, -(i + 1)).toISOString(),
      })),
      // Two results as they look once brought in from the old app.
      { id: 'old1', draw_date: '2025-12-20', status: 'completed', winning_number: 47, winner_name: 'Kev', amount_won: 80, rollover_amount: 0, completed_at: '2025-12-20T20:00:00Z' },
      { id: 'old0', draw_date: '2025-12-13', status: 'completed', winning_number: 59, winner_name: null, amount_won: 0, rollover_amount: 0, completed_at: '2025-12-13T20:00:00Z' },
    ],
    members: [
      { id: 'demo-user', email: myEmail, full_name: 'Sam' },
      { id: 'm2', email: 'jean@example.test', full_name: 'Auntie Jean' },
    ],
    scheduled_notifications: [
      { id: 's1', title: 'Announcement', body: 'Pay up for Saturday', target: 'unpaid', delivery_mode: 'push', send_at: weeksFrom(draw, 0).toISOString(), repeat_rule: 'weekly:Fri:18:00', active: true, created_at: new Date().toISOString() },
    ],
    push_subscriptions: [],
    bonus_ball_chat: [
      { id: 'c1', user_id: null, name: 'Bonus Ball', kind: 'system', body: "Saturday's ball is in. Open the app to see it.", created_at: weeksFrom(draw, -1).toISOString() },
      { id: 'c2', user_id: 'm2', name: 'Auntie Jean', kind: 'user', body: 'GET IN. Drinks are on me (one each)', created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: 'c3', user_id: 'm3', name: 'Kev', kind: 'user', body: 'Fix. Demand a recount', created_at: new Date(Date.now() - 3000000).toISOString() },
    ],
    bonus_ball_reactions: [
      { id: 'r1', draw_id: 'w0', user_id: 'm2', emoji: '🎉', created_at: new Date().toISOString() },
      { id: 'r2', draw_id: 'w0', user_id: 'm3', emoji: '😡', created_at: new Date().toISOString() },
    ],
  } as Record<string, any[]>;
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

class Query {
  private filters: ((row: any) => boolean)[] = [];
  private op: 'select' | 'update' | 'insert' | 'delete' | 'upsert' = 'select';
  private payload: any = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private wantSingle = false;
  private max: number | null = null;
  constructor(private tables: Record<string, any[]>, private table: string) {}

  select() { return this; }
  update(values: any) { this.op = 'update'; this.payload = values; return this; }
  insert(values: any) { this.op = 'insert'; this.payload = values; return this; }
  upsert(values: any) { this.op = 'upsert'; this.payload = values; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: any) { this.filters.push((r) => r[col] === val); return this; }
  gt(col: string, val: any) { this.filters.push((r) => r[col] > val); return this; }
  gte(col: string, val: any) { this.filters.push((r) => r[col] >= val); return this; }
  lte(col: string, val: any) { this.filters.push((r) => r[col] <= val); return this; }
  limit(n: number) { this.max = n; return this; }
  in(col: string, vals: any[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  not() { return this; } // only used as "every row"
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending !== false }; return this; }
  single() { this.wantSingle = true; return this; }

  private run() {
    const rows = (this.tables[this.table] ??= []);
    const match = (r: any) => this.filters.every((f) => f(r));
    let result: any[] = [];
    if (this.op === 'select') {
      result = rows.filter(match);
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        result = [...result].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
    } else if (this.op === 'update') {
      result = rows.filter(match);
      result.forEach((r) => Object.assign(r, clone(this.payload)));
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      result = list.map((v) => ({ id: Math.random().toString(36).slice(2), created_at: new Date().toISOString(), ...clone(v) }));
      rows.push(...result);
    } else if (this.op === 'delete') {
      result = rows.filter(match);
      this.tables[this.table] = rows.filter((r) => !match(r));
    }
    if (this.max != null) result = result.slice(0, this.max);
    if (this.wantSingle) {
      return result.length ? { data: clone(result[0]), error: null } : { data: null, error: { message: 'No rows found' } };
    }
    return { data: clone(result), error: null };
  }

  then<T>(resolve: (value: { data: any; error: any }) => T, reject?: (reason: any) => any) {
    return Promise.resolve().then(() => this.run()).then(resolve, reject);
  }
}

export const createDemoClient = (role: 'member' | 'admin') => {
  const tables = buildTables(role);
  const email = role === 'admin' ? DEMO_ADMIN_EMAIL : DEMO_MEMBER_EMAIL;
  let session: any = { user: { id: 'demo-user', email } };
  const listeners = new Set<(event: string, session: any) => void>();
  const emit = (event: string) => listeners.forEach((cb) => cb(event, session));
  console.info(`[demo] Running on made-up data as ${role}. Nothing is saved.`);

  return {
    from: (table: string) => new Query(tables, table),
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} };
      return ch;
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session?.user ?? null }, error: null }),
      onAuthStateChange: (cb: (event: string, session: any) => void) => {
        listeners.add(cb);
        setTimeout(() => cb('INITIAL_SESSION', session), 0);
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
      },
      signInWithPassword: async () => {
        session = { user: { id: 'demo-user', email } };
        emit('SIGNED_IN');
        return { data: { user: session.user, session }, error: null };
      },
      signUp: async () => ({ data: { user: null, session: null }, error: { message: 'Sign-up is switched off in demo mode.' } }),
      signOut: async () => {
        session = null;
        emit('SIGNED_OUT');
        return { error: null };
      },
      updateUser: async () => ({ data: { user: session?.user ?? null }, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
    },
  };
};
