-- The hospital runs 24/7. Appointment starts are generated on demand every
-- half hour; each department can reserve one booking for each start time.

alter table public.appointments
  add constraint appointments_half_hour_grid_check
  check (
    status not in ('scheduled', 'entry_pending', 'checked_in')
    or mod(extract(epoch from appointment_at)::numeric, 1800) = 0
  );

create unique index appointments_one_active_department_start
  on public.appointments (department_slug, appointment_at)
  where department_slug is not null
    and status in ('scheduled', 'entry_pending', 'checked_in');

drop function if exists public.find_available_appointment_slots(text, timestamptz, timestamptz);
create or replace function public.find_available_appointment_slots(
  department_slug_input text,
  starts_at_input timestamptz,
  ends_at_input timestamptz
)
returns table (department_slug text, department_name text, starts_at timestamptz, duration_minutes integer, remaining_capacity integer)
language sql
security definer
set search_path = public
as $$
  with department as (
    select slug, name from public.departments where slug = department_slug_input and active
  ), starts as (
    select generate_series(
      date_bin(interval '30 minutes', greatest(starts_at_input, now()), timestamptz '2000-01-01 00:00:00+00') + interval '30 minutes',
      ends_at_input,
      interval '30 minutes'
    ) as starts_at
  )
  select department.slug, department.name, starts.starts_at,
    30, 1
  from starts cross join department
  where starts.starts_at <= ends_at_input
    and not exists (
      select 1 from public.appointments appointment
      where appointment.department_slug = department.slug
        and appointment.appointment_at = starts.starts_at
        and appointment.status in ('scheduled', 'entry_pending', 'checked_in')
    )
  order by starts.starts_at
  limit 20;
$$;

drop function if exists public.create_ai_booking(uuid, text, uuid, text);
create function public.create_ai_booking(
  action_uuid uuid,
  department_slug_input text,
  appointment_at_input timestamptz,
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
    select id into command_uuid from public.door_commands where appointment_id = prior_appointment.id;
    return jsonb_build_object('ok', true, 'duplicate', true, 'booking_code', prior_appointment.booking_code,
      'appointment_at', prior_appointment.appointment_at, 'appointment_id', prior_appointment.id,
      'door_command_id', command_uuid, 'door_open_required', command_uuid is not null,
      'department_slug', prior_appointment.department_slug);
  end if;
  if current_action.outcome <> 'in_progress' then
    return jsonb_build_object('ok', false, 'reason', 'session_already_used');
  end if;
  if char_length(btrim(patient_name_input)) not between 2 and 120 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_name');
  end if;
  if not exists (select 1 from public.departments where slug = department_slug_input and active) then
    return jsonb_build_object('ok', false, 'reason', 'department_unavailable');
  end if;
  if appointment_at_input <= now() then
    return jsonb_build_object('ok', false, 'reason', 'slot_in_past');
  end if;
  if mod(extract(epoch from appointment_at_input)::numeric, 1800) <> 0 then
    return jsonb_build_object('ok', false, 'reason', 'slot_unavailable');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(department_slug_input || '|' || extract(epoch from appointment_at_input)::bigint::text, 0));
  if exists (
    select 1 from public.appointments appointment
    where appointment.department_slug = department_slug_input
      and appointment.appointment_at = appointment_at_input
      and appointment.status in ('scheduled', 'entry_pending', 'checked_in')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'slot_full');
  end if;

  generated_code := public.generate_available_booking_code();
  immediate_entry := public.appointment_window_reason(appointment_at_input, now()) = 'valid';
  insert into public.appointments (booking_code, patient_name, department_slug, appointment_at, status, creation_action_id)
  values (generated_code, btrim(patient_name_input), department_slug_input, appointment_at_input,
    case when immediate_entry then 'entry_pending' else 'scheduled' end, action_uuid)
  returning id into appointment_uuid;

  update public.ai_actions set outcome = 'accepted', booking_code = generated_code, decision_reason = 'booking_created'
  where id = action_uuid;
  if immediate_entry then
    insert into public.door_commands (ai_action_id, appointment_id, simulated)
    values (action_uuid, appointment_uuid, current_action.source = 'simulation') returning id into command_uuid;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'booking_code', generated_code,
    'appointment_id', appointment_uuid, 'appointment_at', appointment_at_input,
    'department_slug', department_slug_input, 'door_command_id', command_uuid,
    'door_open_required', immediate_entry, 'source', current_action.source);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'slot_full');
end;
$$;

drop function if exists public.create_admin_booking(text, text, text, uuid);
create function public.create_admin_booking(
  booking_code_input text,
  patient_name_input text,
  department_slug_input text,
  appointment_at_input timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  appointment_uuid uuid;
begin
  perform public.expire_old_appointments();
  if appointment_at_input <= now() then
    return jsonb_build_object('ok', false, 'reason', 'slot_in_past');
  end if;
  if mod(extract(epoch from appointment_at_input)::numeric, 1800) <> 0
      or not exists (select 1 from public.departments where slug = department_slug_input and active) then
    return jsonb_build_object('ok', false, 'reason', 'slot_unavailable');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(department_slug_input || '|' || extract(epoch from appointment_at_input)::bigint::text, 0));
  if exists (
    select 1 from public.appointments appointment
    where appointment.department_slug = department_slug_input
      and appointment.appointment_at = appointment_at_input
      and appointment.status in ('scheduled', 'entry_pending', 'checked_in')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'slot_full');
  end if;
  insert into public.appointments (booking_code, patient_name, department_slug, appointment_at)
  values (booking_code_input, btrim(patient_name_input), department_slug_input, appointment_at_input)
  returning id into appointment_uuid;
  return jsonb_build_object('ok', true, 'appointment_id', appointment_uuid);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'code_in_use');
end;
$$;

revoke all on function public.find_available_appointment_slots(text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.create_ai_booking(uuid, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.create_admin_booking(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.find_available_appointment_slots(text, timestamptz, timestamptz) to service_role;
grant execute on function public.create_ai_booking(uuid, text, timestamptz, text) to service_role;
grant execute on function public.create_admin_booking(text, text, text, timestamptz) to service_role;
