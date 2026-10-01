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
begin
  for attempt_number in 1..100 loop
    random_bytes := extensions.gen_random_bytes(4);
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
