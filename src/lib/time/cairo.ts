const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function cairoOffsetMinutes(instant: Date) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    timeZoneName: "longOffset",
  }).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$|^GMT$/.exec(name ?? "");
  if (!match) throw new Error("Could not resolve Africa/Cairo UTC offset.");
  const minutes = Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

export function cairoLocalDateTimeToIso(localDateTime: string) {
  const match = localDateTimePattern.exec(localDateTime);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const initialOffset = cairoOffsetMinutes(new Date(localAsUtc));
  let instant = new Date(localAsUtc - initialOffset * 60_000);
  const actualOffset = cairoOffsetMinutes(instant);
  if (actualOffset !== initialOffset) instant = new Date(localAsUtc - actualOffset * 60_000);

  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` !== localDateTime) return null;
  return instant.toISOString();
}

function addCalendarDay(date: string) {
  if (!datePattern.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  return `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDay.getUTCDate()).padStart(2, "0")}`;
}

export function cairoDateRangeToUtc(dateFrom: string, dateTo: string) {
  if (!datePattern.test(dateFrom) || !datePattern.test(dateTo) || dateFrom > dateTo) return null;
  const nextDay = addCalendarDay(dateTo);
  const startsAt = cairoLocalDateTimeToIso(`${dateFrom}T00:00`);
  const requestedEndDay = cairoLocalDateTimeToIso(`${dateTo}T00:00`);
  const nextDayStart = nextDay ? cairoLocalDateTimeToIso(`${nextDay}T00:00`) : null;
  if (!startsAt || !requestedEndDay || !nextDayStart) return null;
  const endsAt = new Date(Date.parse(nextDayStart) - 1).toISOString();
  return { startsAt, endsAt };
}
