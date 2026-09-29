/**
 * Who a non-production stack may email.
 *
 * The local database holds real customers — measured 29 Sep 2026: 8 of the 9
 * local users have real-looking addresses, some of them customers. With a real
 * SMTP login in `.env.docker`, any local job (expiry notices, renewal reminders,
 * a password reset somebody clicks) would reach them. So when
 * EMAIL_RECIPIENT_ALLOWLIST is set, mail goes ONLY to what it lists:
 *
 *   EMAIL_RECIPIENT_ALLOWLIST="@anutech.in, pawan@exceltechnologies.in"
 *
 * An entry starting with "@" allows that whole domain (exact domain, not its
 * subdomains); anything else is one exact address. Case does not matter.
 *
 * UNSET means no filter, which is what production needs. That is the one place
 * this leans open, and it is deliberate: the variable is only ever set on a dev
 * machine, and a production deploy that filtered by default would silently stop
 * every customer email.
 */
export interface AllowlistDecision {
  allowed: boolean;
  /** Why not, for the log. Null when allowed. */
  reason: string | null;
}

export function parseAllowlist(raw: string | undefined): string[] | null {
  if (raw === undefined || !raw.trim()) return null;
  return raw
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function recipientAllowed(to: string, raw: string | undefined): AllowlistDecision {
  const list = parseAllowlist(raw);
  if (list === null) return { allowed: true, reason: null };

  const addr = to.trim().toLowerCase();
  const domain = addr.includes("@") ? addr.slice(addr.lastIndexOf("@")) : null;
  const ok = list.some((e) => (e.startsWith("@") ? e === domain : e === addr));
  return ok
    ? { allowed: true, reason: null }
    : { allowed: false, reason: `${to} is not on EMAIL_RECIPIENT_ALLOWLIST, so it was not sent` };
}
