-- Include an aligned request boundary (including midnight) and expose one
-- full day's worth of alternatives while keeping tool replies bounded.
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
      date_bin(interval '30 minutes', starts_at_input, timestamptz '2000-01-01 00:00:00+00'),
      ends_at_input,
      interval '30 minutes'
    ) as starts_at
  )
  select department.slug, department.name, starts.starts_at, 30, 1
  from starts cross join department
  where starts.starts_at >= starts_at_input
    and starts.starts_at > now()
    and starts.starts_at <= ends_at_input
    and not exists (
      select 1 from public.appointments appointment
      where appointment.department_slug = department.slug
        and appointment.appointment_at = starts.starts_at
        and appointment.status in ('scheduled', 'entry_pending', 'checked_in')
    )
  order by starts.starts_at
  limit 48;
$$;

revoke all on function public.find_available_appointment_slots(text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.find_available_appointment_slots(text, timestamptz, timestamptz) to service_role;
