export type DeviceDoorResult = "door_opened" | "door_failed" | "door_pending";

function waitForPoll(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, 500);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

// The browser reads status only. Only the ESP32 acknowledges physical commands.
export async function waitForDeviceDoor(
  requestId: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DeviceDoorResult> {
  const deadline = Date.now() + 18_000;
  while (!signal.aborted && Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetch(`/api/ai/door-status?${new URLSearchParams({ request_id: requestId })}`, {
        headers, cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
      });
    } catch (error) {
      if (signal.aborted) return "door_pending";
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "TimeoutError")) throw error;
      await waitForPoll(signal);
      continue;
    }
    if (response.status >= 500) { await waitForPoll(signal); continue; }
    if (!response.ok) throw new Error("تعذّر قراءة تأكيد ESP32. راجع توكن الجهاز والاتصال.");
    const payload = await response.json() as { command?: { simulated?: boolean; status?: string } | null };
    if (payload.command) {
      if (payload.command.simulated !== false) throw new Error("الرد ليس لأمر باب فعلي.");
      if (payload.command.status === "opened") return "door_opened";
      if (payload.command.status === "failed" || payload.command.status === "expired") return "door_failed";
    }
    await waitForPoll(signal);
  }
  return "door_pending";
}
