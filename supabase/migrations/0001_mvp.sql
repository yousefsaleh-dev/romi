create extension if not exists pgcrypto;

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  booking_code text not null check (booking_code ~ '^[0-9]{4}$'),
  appointment_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'checked_in', 'cancelled')),
  created_at timestamptz not null default now()
);

create unique index if not exists appointments_one_scheduled_code
  on public.appointments (booking_code)
  where status = 'scheduled';

create index if not exists appointments_appointment_at_idx
  on public.appointments (appointment_at desc);

create table if not exists public.ai_actions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  source text not null default 'kiosk' check (source in ('kiosk', 'simulation')),
  booking_code text check (booking_code is null or booking_code ~ '^[0-9]{4}$'),
  outcome text not null check (outcome in (
    'in_progress', 'accepted', 'rejected', 'missing_code', 'provider_error'
  )),
  reply_text text,
  provider text not null default 'google',
  model text not null,
  text_input_tokens integer not null default 0 check (text_input_tokens >= 0),
  text_output_tokens integer not null default 0 check (text_output_tokens >= 0),
  audio_input_tokens integer not null default 0 check (audio_input_tokens >= 0),
  audio_output_tokens integer not null default 0 check (audio_output_tokens >= 0),
  estimated_cost_usd numeric(12, 8) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  usage_finalized boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists ai_actions_created_at_idx
  on public.ai_actions (created_at desc);

create table if not exists public.door_commands (
  id uuid primary key default gen_random_uuid(),
  ai_action_id uuid not null unique references public.ai_actions(id) on delete cascade,
  simulated boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'opened', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '20 seconds'),
  sent_at timestamptz,
  acknowledged_at timestamptz,
  opened_at timestamptz,
  error_code text,
  check (expires_at > created_at)
);

create index if not exists door_commands_pending_idx
  on public.door_commands (created_at)
  where status = 'pending';

alter table public.appointments enable row level security;
alter table public.ai_actions enable row level security;
alter table public.door_commands enable row level security;

create policy "Admin can read appointments"
  on public.appointments for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Admin can create appointments"
  on public.appointments for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Admin can update appointments"
  on public.appointments for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Admin can delete appointments"
  on public.appointments for delete to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Admin can read AI actions"
  on public.ai_actions for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Admin can read door commands"
  on public.door_commands for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create or replace function public.claim_next_door_command()
returns setof public.door_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  update public.door_commands
  set status = 'expired'
  where status = 'pending' and expires_at <= now();

  update public.door_commands as command
  set status = 'sent', sent_at = now()
  where command.id = (
    select candidate.id
    from public.door_commands as candidate
    where candidate.status = 'pending'
      and candidate.expires_at > now()
      and candidate.simulated = false
    order by candidate.created_at
    for update skip locked
    limit 1
  )
  returning command.id into claimed_id;

  if claimed_id is null then
    return;
  end if;

  return query
    select * from public.door_commands where id = claimed_id;
end;
$$;

create or replace function public.complete_booking_checkin(
  appointment_uuid uuid,
  action_uuid uuid,
  code text,
  is_simulation boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_appointment uuid;
begin
  update public.appointments
  set status = 'checked_in'
  where id = appointment_uuid and booking_code = code and status = 'scheduled'
  returning id into claimed_appointment;

  if claimed_appointment is null then
    return false;
  end if;

  update public.ai_actions
  set outcome = 'accepted', booking_code = code,
      source = case when is_simulation then 'simulation' else 'kiosk' end,
      reply_text = 'تم تأكيد الحجز. جارٍ إرسال أمر فتح الباب.'
  where id = action_uuid and outcome = 'in_progress';

  if not found then
    raise exception 'AI action is not awaiting a booking';
  end if;

  insert into public.door_commands (ai_action_id, simulated)
  values (action_uuid, is_simulation);

  return true;
end;
$$;

create or replace function public.complete_simulation_check(
  appointment_uuid uuid,
  action_uuid uuid,
  code text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  valid_appointment uuid;
begin
  select id into valid_appointment
  from public.appointments
  where id = appointment_uuid and booking_code = code and status = 'scheduled'
  for update;

  if valid_appointment is null then
    return false;
  end if;

  update public.ai_actions
  set outcome = 'accepted', booking_code = code, source = 'simulation',
      reply_text = 'تم التحقق من الحجز (محاكاة).'
  where id = action_uuid and source = 'simulation' and outcome = 'in_progress';

  if not found then
    raise exception 'AI simulation is not awaiting a booking';
  end if;

  insert into public.door_commands (ai_action_id, simulated)
  values (action_uuid, true);

  return true;
end;
$$;

create or replace function public.acknowledge_door_command(
  command_id uuid,
  opened boolean,
  failure_code text default null
)
returns public.door_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_command public.door_commands;
begin
  update public.door_commands
  set status = case when opened then 'opened' else 'failed' end,
      acknowledged_at = now(),
      opened_at = case when opened then now() else null end,
      error_code = case when opened then null else left(failure_code, 80) end
  where id = command_id
    and status = 'sent'
    and simulated = false
    and expires_at > now()
  returning * into updated_command;

  return updated_command;
end;
$$;

revoke all on function public.claim_next_door_command() from public, anon, authenticated;
revoke all on function public.acknowledge_door_command(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.complete_booking_checkin(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.complete_simulation_check(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_next_door_command() to service_role;
grant execute on function public.acknowledge_door_command(uuid, boolean, text) to service_role;
grant execute on function public.complete_booking_checkin(uuid, uuid, text, boolean) to service_role;
grant execute on function public.complete_simulation_check(uuid, uuid, text) to service_role;

grant select, insert, update, delete on public.appointments to authenticated;
grant select on public.ai_actions, public.door_commands to authenticated;
grant all on public.appointments, public.ai_actions, public.door_commands to service_role;
