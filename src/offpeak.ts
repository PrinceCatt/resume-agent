// DeepSeek's peak hours, when every call costs twice the off-peak price: Beijing time (UTC+8, the same
// clock as Singapore) Monday to Friday 9:00–12:00 and 14:00–18:00. Public holidays are treated as normal
// weekdays, so on a holiday batch work only waits longer than it needs to. Shared by the server (which
// holds batch work) and the UI (which says until when).
const BJ = 8 * 3600_000;

export function isPeak(d = new Date()) {
  const bj = new Date(d.getTime() + BJ);
  const day = bj.getUTCDay();
  const m = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return day >= 1 && day <= 5 && ((m >= 9 * 60 && m < 12 * 60) || (m >= 14 * 60 && m < 18 * 60));
}

/** When the current peak ends (12:00 or 18:00 Beijing time); null when it is off-peak now. */
export function peakEnds(d = new Date()): Date | null {
  if (!isPeak(d)) return null;
  const bj = new Date(d.getTime() + BJ);
  bj.setUTCHours(bj.getUTCHours() < 12 ? 12 : 18, 0, 0, 0);
  return new Date(bj.getTime() - BJ);
}

/** "12:00" or "18:00" on this computer's clock, for "waits until …". */
export function peakEndLabel(d = new Date()) {
  const end = peakEnds(d);
  return end ? end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}
