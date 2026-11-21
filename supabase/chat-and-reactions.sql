-- Bonus Ball: family chat and reactions.
-- Paste this whole block into Supabase > SQL Editor and press Run. It is safe to run twice.

-- 1. Family chat ------------------------------------------------------------
create table if not exists public.bonus_ball_chat (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  name text not null,
  body text not null check (char_length(body) between 1 and 500),
  kind text not null default 'user',
  created_at timestamptz not null default now()
);
create index if not exists bonus_ball_chat_created_idx on public.bonus_ball_chat (created_at desc);

alter table public.bonus_ball_chat enable row level security;

drop policy if exists "chat: signed-in people can read" on public.bonus_ball_chat;
create policy "chat: signed-in people can read" on public.bonus_ball_chat
  for select to authenticated using (true);

drop policy if exists "chat: post as yourself" on public.bonus_ball_chat;
create policy "chat: post as yourself" on public.bonus_ball_chat
  for insert to authenticated with check (user_id = auth.uid() and kind = 'user');

drop policy if exists "chat: delete your own, admin deletes any" on public.bonus_ball_chat;
create policy "chat: delete your own, admin deletes any" on public.bonus_ball_chat
  for delete to authenticated
  using (user_id = auth.uid() or lower(auth.jwt() ->> 'email') = 'carlwhalliday@icloud.com');

-- 2. Reactions on a draw ----------------------------------------------------
create table if not exists public.bonus_ball_reactions (
  id uuid primary key default gen_random_uuid(),
  draw_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null check (char_length(emoji) <= 8),
  created_at timestamptz not null default now(),
  unique (draw_id, user_id, emoji)
);
create index if not exists bonus_ball_reactions_draw_idx on public.bonus_ball_reactions (draw_id);

alter table public.bonus_ball_reactions enable row level security;

drop policy if exists "reactions: signed-in people can read" on public.bonus_ball_reactions;
create policy "reactions: signed-in people can read" on public.bonus_ball_reactions
  for select to authenticated using (true);

drop policy if exists "reactions: add your own" on public.bonus_ball_reactions;
create policy "reactions: add your own" on public.bonus_ball_reactions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "reactions: remove your own" on public.bonus_ball_reactions;
create policy "reactions: remove your own" on public.bonus_ball_reactions
  for delete to authenticated using (user_id = auth.uid());

-- 3. Let new chat messages appear without refreshing -------------------------
do $$
begin
  alter publication supabase_realtime add table public.bonus_ball_chat;
exception
  when duplicate_object then null; -- already added
end $$;
