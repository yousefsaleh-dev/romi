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
    and appointment.status = 'entry_pending'
    -- An older expired command must not release a newer retry's reservation.
    and not exists (
      select 1 from public.door_commands active_command
      where active_command.appointment_id = appointment.id
        and active_command.status in ('pending', 'sent')
        and active_command.expires_at > now()
    );
end;
$$;
