create table if not exists public.departments (
  slug text primary key check (slug ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null unique check (char_length(name) between 2 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.departments (slug, name) values
  ('general', 'الاستقبال العام'),
  ('internal_medicine', 'الباطنة'),
  ('pediatrics', 'الأطفال'),
  ('orthopedics', 'العظام')
on conflict (slug) do nothing;

create table if not exists public.appointment_slots (
  id uuid primary key default gen_random_uuid(),
  department_slug text not null references public.departments(slug),
  starts_at timestamptz not null,
  duration_minutes integer not null default 30 check (duration_minutes between 10 and 240),
  capacity integer not null check (capacity between 1 and 500),
  is_open boolean not null default true,
  created_at timestamptz not null default now(),
  unique (department_slug, starts_at)
);

alter table public.appointments
  add column if not exists patient_name text,
  add column if not exists department_slug text references public.departments(slug),
  add column if not exists slot_id uuid references public.appointment_slots(id),
  add column if not exists creation_action_id uuid references public.ai_actions(id) on delete set null;

alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in ('scheduled', 'entry_pending', 'checked_in', 'cancelled', 'expired'));
alter table public.appointments drop constraint if exists appointments_patient_name_check;
alter table public.appointments add constraint appointments_patient_name_check
  check (patient_name is null or char_length(btrim(patient_name)) between 2 and 120);

drop index if exists public.appointments_one_scheduled_code;
create unique index appointments_one_active_code
  on public.appointments (booking_code)
  where status in ('scheduled', 'entry_pending');

create index if not exists appointment_slots_search_idx
  on public.appointment_slots (department_slug, starts_at)
  where is_open;

alter table public.ai_actions
  add column if not exists attempt_count integer not null default 0 check (attempt_count >= 0),
  add column if not exists decision_reason text check (decision_reason is null or decision_reason in (
    'not_found', 'already_used', 'expired', 'too_early', 'cancelled', 'door_pending',
    'valid', 'door_failed', 'slot_unavailable', 'booking_created'
  ));

alter table public.door_commands
  add column if not exists appointment_id uuid references public.appointments(id) on delete set null;

create table if not exists public.booking_attempts (
  id uuid primary key default gen_random_uuid(),
  ai_action_id uuid not null references public.ai_actions(id) on delete cascade,
  booking_code text not null check (booking_code ~ '^[0-9]{4}$'),
  reason text not null check (reason in (
    'not_found', 'already_used', 'expired', 'too_early', 'cancelled', 'door_pending', 'accepted'
  )),
  created_at timestamptz not null default now()
);

create index if not exists booking_attempts_action_idx
  on public.booking_attempts (ai_action_id, created_at desc);

alter table public.departments enable row level security;
alter table public.appointment_slots enable row level security;
alter table public.booking_attempts enable row level security;

create policy "Admin can read departments"
  on public.departments for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Admin can manage departments"
  on public.departments for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Admin can manage appointment slots"
  on public.appointment_slots for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Admin can read booking attempts"
  on public.booking_attempts for select to authenticated
  using (exists (
    select 1 from public.ai_actions action
    where action.id = booking_attempts.ai_action_id
      and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  ));

grant select, insert, update, delete on public.departments, public.appointment_slots to authenticated;
grant select on public.booking_attempts to authenticated;
grant all on public.departments, public.appointment_slots, public.booking_attempts to service_role;

create or replace function public.appointment_window_reason(appointment_at_input timestamptz, checked_at_input timestamptz)
returns text
language sql
immutable
as $$
  -- The arrival window includes one hour early and excludes the exact two-hour expiry boundary.
  select case
    when checked_at_input < appointment_at_input - interval '1 hour' then 'too_early'
    when checked_at_input >= appointment_at_input + interval '2 hours' then 'expired'
    else 'valid'
  end;
$$;

create or replace function public.expire_old_appointments()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.appointments
  set status = 'expired'
  where status = 'scheduled'
    and public.appointment_window_reason(appointment_at, now()) = 'expired';

  update public.door_commands command
  set status = 'expired'
  where command.status in ('pending', 'sent')
    and command.expires_at <= now();

  update public.appointments appointment
  set status = case
    when public.appointment_window_reason(appointment.appointment_at, now()) = 'expired' then 'expired'
    else 'scheduled'
  end
  from public.door_commands command
  where command.appointment_id = appointment.id
    and command.status = 'expired'
    and appointment.status = 'entry_pending';
end;
$$;

create or replace function public.generate_available_booking_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  random_bytes bytea;
  generated_code text;
  random_number bigint;
  attempt_number integer;
begin
  for attempt_number in 1..100 loop
    random_bytes := gen_random_bytes(4);
    random_number := get_byte(random_bytes, 0)::bigint * 16777216
      + get_byte(random_bytes, 1)::bigint * 65536
      + get_byte(random_bytes, 2)::bigint * 256
      + get_byte(random_bytes, 3)::bigint;
    generated_code := lpad((random_number % 10000)::text, 4, '0');

    if not exists (
      select 1 from public.appointments appointment
      where appointment.booking_code = generated_code
        and (
          appointment.status in ('scheduled', 'entry_pending')
          or (appointment.status = 'checked_in' and public.appointment_window_reason(appointment.appointment_at, now()) = 'valid')
        )
    ) then
      return generated_code;
    end if;
  end loop;

  raise exception 'No available four-digit booking code';
end;
$$;

create or replace function public.create_admin_booking(
  booking_code_input text,
  patient_name_input text,
  department_slug_input text,
  slot_uuid uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_slot public.appointment_slots;
  reserved_count integer;
  appointment_id uuid;
begin
  perform public.expire_old_appointments();

  select * into selected_slot
  from public.appointment_slots
  where id = slot_uuid and department_slug = department_slug_input and is_open
  for update;

  if selected_slot.id is null then
    return jsonb_build_object('ok', false, 'reason', 'slot_unavailable');
  end if;
  if selected_slot.starts_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'slot_in_past');
  end if;

  select count(*) into reserved_count
  from public.appointments
  where slot_id = selected_slot.id and status in ('scheduled', 'entry_pending', 'checked_in');

  if reserved_count >= selected_slot.capacity then
    return jsonb_build_object('ok', false, 'reason', 'slot_full');
  end if;

  insert into public.appointments (booking_code, patient_name, department_slug, slot_id, appointment_at)
  values (booking_code_input, btrim(patient_name_input), department_slug_input, selected_slot.id, selected_slot.starts_at)
  returning id into appointment_id;

  return jsonb_build_object('ok', true, 'appointment_id', appointment_id);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'code_in_use');
end;
$$;

create or replace function public.find_available_appointment_slots(
  department_slug_input text,
  starts_at_input timestamptz,
  ends_at_input timestamptz
)
returns table (id uuid, department_slug text, department_name text, starts_at timestamptz, duration_minutes integer, remaining_capacity integer)
language sql
security definer
set search_path = public
as $$
  select slot.id, slot.department_slug, department.name, slot.starts_at, slot.duration_minutes,
    greatest(slot.capacity - count(appointment.id)::integer, 0) as remaining_capacity
  from public.appointment_slots slot
  join public.departments department on department.slug = slot.department_slug and department.active
  left join public.appointments appointment
    on appointment.slot_id = slot.id
    and appointment.status in ('scheduled', 'entry_pending', 'checked_in')
  where slot.department_slug = department_slug_input
    and slot.is_open
    and slot.starts_at between starts_at_input and ends_at_input
    and slot.starts_at >= now()
  group by slot.id, slot.department_slug, department.name, slot.starts_at, slot.duration_minutes, slot.capacity
  having count(appointment.id) < slot.capacity
  order by slot.starts_at
  limit 20;
$$;

create or replace function public.create_ai_booking(
  action_uuid uuid,
  department_slug_input text,
  slot_uuid uuid,
  patient_name_input text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_action public.ai_actions;
  prior_appointment public.appointments;
  selected_slot public.appointment_slots;
  reserved_count integer;
  appointment_uuid uuid;
  generated_code text;
  immediate_entry boolean;
  command_uuid uuid;
begin
  perform public.expire_old_appointments();

  select * into current_action from public.ai_actions where id = action_uuid for update;
  if current_action.id is null then
    return jsonb_build_object('ok', false, 'reason', 'session_missing');
  end if;

  select * into prior_appointment from public.appointments appointment
  where appointment.creation_action_id = action_uuid;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'booking_code', prior_appointment.booking_code,
      'appointment_at', prior_appointment.appointment_at, 'appointment_id', prior_appointment.id);
  end if;

  if current_action.outcome <> 'in_progress' then
    return jsonb_build_object('ok', false, 'reason', 'session_already_used');
  end if;
  if char_length(btrim(patient_name_input)) not between 2 and 120 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_name');
  end if;

  select * into selected_slot from public.appointment_slots
  where id = slot_uuid and department_slug = department_slug_input and is_open
  for update;
  if selected_slot.id is null or selected_slot.starts_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'slot_unavailable');
  end if;

  select count(*) into reserved_count from public.appointments
  where slot_id = selected_slot.id and status in ('scheduled', 'entry_pending', 'checked_in');
  if reserved_count >= selected_slot.capacity then
    return jsonb_build_object('ok', false, 'reason', 'slot_full');
  end if;

  generated_code := public.generate_available_booking_code();
  immediate_entry := public.appointment_window_reason(selected_slot.starts_at, now()) = 'valid';

  insert into public.appointments (
    booking_code, patient_name, department_slug, slot_id, appointment_at,
    status, creation_action_id
  ) values (
    generated_code, btrim(patient_name_input), department_slug_input, selected_slot.id,
    selected_slot.starts_at, case when immediate_entry then 'entry_pending' else 'scheduled' end,
    action_uuid
  ) returning id into appointment_uuid;

  update public.ai_actions set outcome = 'accepted', booking_code = generated_code,
    decision_reason = 'booking_created'
  where id = action_uuid;

  if immediate_entry then
    insert into public.door_commands (ai_action_id, appointment_id, simulated)
    values (action_uuid, appointment_uuid, current_action.source = 'simulation')
    returning id into command_uuid;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'booking_code', generated_code,
    'appointment_id', appointment_uuid, 'appointment_at', selected_slot.starts_at,
    'department_slug', department_slug_input, 'door_command_id', command_uuid,
    'door_open_required', immediate_entry, 'source', current_action.source);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'code_generation_conflict');
end;
$$;

create or replace function public.attempt_booking_checkin(action_uuid uuid, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_action public.ai_actions;
  selected_appointment public.appointments;
  latest_appointment public.appointments;
  new_attempt_count integer;
  denial_reason text;
  command_uuid uuid;
begin
  perform public.expire_old_appointments();

  select * into current_action from public.ai_actions where id = action_uuid for update;
  if current_action.id is null then
    return jsonb_build_object('ok', false, 'reason', 'session_missing');
  end if;
  if current_action.outcome = 'accepted' then
    select id into command_uuid from public.door_commands where ai_action_id = action_uuid;
    return jsonb_build_object('ok', true, 'duplicate', true, 'reason', current_action.decision_reason,
      'booking_code', current_action.booking_code, 'door_command_id', command_uuid);
  end if;
  if current_action.outcome <> 'in_progress' then
    return jsonb_build_object('ok', false, 'reason', 'attempts_exhausted', 'attempts_remaining', 0);
  end if;

  select * into selected_appointment from public.appointments
  where booking_code = code and status = 'scheduled'
  order by appointment_at desc limit 1 for update;

  if selected_appointment.id is not null then
    denial_reason := public.appointment_window_reason(selected_appointment.appointment_at, now());
    if denial_reason = 'expired' then
      update public.appointments set status = 'expired' where id = selected_appointment.id;
    elsif denial_reason = 'valid' then
      update public.appointments set status = 'entry_pending' where id = selected_appointment.id;
      update public.ai_actions set outcome = 'accepted', booking_code = code, decision_reason = 'valid'
        where id = action_uuid;
      insert into public.door_commands (ai_action_id, appointment_id, simulated)
      values (action_uuid, selected_appointment.id, current_action.source = 'simulation')
      returning id into command_uuid;
      insert into public.booking_attempts (ai_action_id, booking_code, reason)
      values (action_uuid, code, 'accepted');
      return jsonb_build_object('ok', true, 'reason', 'valid', 'door_command_id', command_uuid,
        'appointment_id', selected_appointment.id, 'source', current_action.source);
    end if;
  else
    select * into latest_appointment from public.appointments
    where booking_code = code
    order by appointment_at desc, created_at desc limit 1;
    denial_reason := case
      when latest_appointment.id is null then 'not_found'
      when latest_appointment.status = 'checked_in' then 'already_used'
      when latest_appointment.status = 'entry_pending' then 'door_pending'
      when latest_appointment.status = 'cancelled' then 'cancelled'
      when latest_appointment.status = 'expired' then 'expired'
      when latest_appointment.status = 'scheduled' then public.appointment_window_reason(latest_appointment.appointment_at, now())
      else 'not_found'
    end;
  end if;

  insert into public.booking_attempts (ai_action_id, booking_code, reason)
  values (action_uuid, code, denial_reason);
  new_attempt_count := current_action.attempt_count + case when denial_reason = 'too_early' then 0 else 1 end;
  update public.ai_actions set attempt_count = new_attempt_count, booking_code = code,
    decision_reason = denial_reason,
    outcome = case when new_attempt_count >= 3 then 'rejected' else 'in_progress' end
  where id = action_uuid;

  return jsonb_build_object('ok', false, 'reason', denial_reason,
    'attempts_remaining', greatest(3 - new_attempt_count, 0));
end;
$$;

create or replace function public.claim_next_door_command()
returns setof public.door_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  perform public.expire_old_appointments();

  update public.door_commands as command
  set status = 'sent', sent_at = now()
  where command.id = (
    select candidate.id from public.door_commands candidate
    where candidate.status = 'pending' and candidate.expires_at > now() and not candidate.simulated
    order by candidate.created_at for update skip locked limit 1
  )
  returning command.id into claimed_id;

  if claimed_id is null then return; end if;
  return query select * from public.door_commands where id = claimed_id;
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
      acknowledged_at = now(), opened_at = case when opened then now() else null end,
      error_code = case when opened then null else left(failure_code, 80) end
  where id = command_id and status = 'sent' and not simulated and expires_at > now()
  returning * into updated_command;

  if updated_command.id is null then return null; end if;

  update public.appointments appointment
  set status = case
    when opened then 'checked_in'
    when public.appointment_window_reason(appointment.appointment_at, now()) = 'expired' then 'expired'
    else 'scheduled'
  end
  where appointment.id = updated_command.appointment_id and appointment.status = 'entry_pending';

  return updated_command;
end;
$$;

create or replace function public.complete_simulation_door_command(command_id uuid)
returns public.door_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_command public.door_commands;
begin
  update public.door_commands
  set status = 'opened', acknowledged_at = now(), opened_at = now()
  where id = command_id and status = 'pending' and simulated and expires_at > now()
  returning * into updated_command;

  if updated_command.id is null then return null; end if;
  update public.appointments set status = 'checked_in'
  where id = updated_command.appointment_id and status = 'entry_pending';
  return updated_command;
end;
$$;

revoke all on function public.expire_old_appointments() from public, anon, authenticated;
revoke all on function public.appointment_window_reason(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.generate_available_booking_code() from public, anon, authenticated;
revoke all on function public.create_admin_booking(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.find_available_appointment_slots(text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.create_ai_booking(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.attempt_booking_checkin(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_next_door_command() from public, anon, authenticated;
revoke all on function public.acknowledge_door_command(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.complete_simulation_door_command(uuid) from public, anon, authenticated;

grant execute on function public.expire_old_appointments() to service_role;
grant execute on function public.appointment_window_reason(timestamptz, timestamptz) to service_role;
grant execute on function public.generate_available_booking_code() to service_role;
grant execute on function public.create_admin_booking(text, text, text, uuid) to service_role;
grant execute on function public.find_available_appointment_slots(text, timestamptz, timestamptz) to service_role;
grant execute on function public.create_ai_booking(uuid, text, uuid, text) to service_role;
grant execute on function public.attempt_booking_checkin(uuid, text) to service_role;
grant execute on function public.claim_next_door_command() to service_role;
grant execute on function public.acknowledge_door_command(uuid, boolean, text) to service_role;
grant execute on function public.complete_simulation_door_command(uuid) to service_role;
