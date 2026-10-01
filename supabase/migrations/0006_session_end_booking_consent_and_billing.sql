alter table public.ai_actions drop constraint if exists ai_actions_outcome_check;
alter table public.ai_actions add constraint ai_actions_outcome_check
  check (outcome in ('in_progress', 'accepted', 'rejected', 'missing_code', 'provider_error', 'completed'));

alter table public.ai_actions
  add column if not exists billing_tier text not null default 'unknown'
    check (billing_tier in ('free', 'paid', 'unknown'));

drop function if exists public.create_ai_booking(uuid, text, timestamptz, text);
create function public.create_ai_booking(
  action_uuid uuid,
  department_slug_input text,
  appointment_at_input timestamptz,
  patient_name_input text,
  open_door_now_input boolean
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
  arrival_window_reason text;
  open_door_now boolean;
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
  arrival_window_reason := public.appointment_window_reason(appointment_at_input, now());
  open_door_now := open_door_now_input and arrival_window_reason = 'valid';
  insert into public.appointments (booking_code, patient_name, department_slug, appointment_at, status, creation_action_id)
  values (generated_code, btrim(patient_name_input), department_slug_input, appointment_at_input,
    case when open_door_now then 'entry_pending' else 'scheduled' end, action_uuid)
  returning id into appointment_uuid;

  update public.ai_actions set outcome = 'accepted', booking_code = generated_code, decision_reason = 'booking_created'
  where id = action_uuid;
  if open_door_now then
    insert into public.door_commands (ai_action_id, appointment_id, simulated)
    values (action_uuid, appointment_uuid, current_action.source = 'simulation') returning id into command_uuid;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'booking_code', generated_code,
    'appointment_id', appointment_uuid, 'appointment_at', appointment_at_input,
    'department_slug', department_slug_input, 'door_command_id', command_uuid,
    'door_open_required', open_door_now,
    'door_open_skipped_reason', case
      when not open_door_now_input then 'visitor_declined'
      when arrival_window_reason <> 'valid' then arrival_window_reason
      else null
    end,
    'source', current_action.source);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'slot_full');
end;
$$;

revoke all on function public.create_ai_booking(uuid, text, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.create_ai_booking(uuid, text, timestamptz, text, boolean) to service_role;
