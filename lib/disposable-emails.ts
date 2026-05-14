/**
 * Disposable / throwaway email-domain blocklist.
 *
 * Hand-curated list of the most-abused services for free-trial signups in the
 * Indian SaaS market. Not exhaustive — new domains pop up weekly. Treat this as
 * a first-line filter, not a definitive answer.
 *
 * Refresh quarterly from upstream lists like:
 *   https://github.com/disposable-email-domains/disposable-email-domains
 *
 * The set is lowercased and matched against the full domain. Subdomains are
 * matched by walking up the dot-segments — e.g. `foo.mailinator.com` is caught
 * because `mailinator.com` is on the list.
 */

const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  // tempmail family
  "tempmail.com",
  "temp-mail.org",
  "temp-mail.io",
  "tempmail.net",
  "tempmailo.com",
  "tempmail.plus",
  "tmpmail.org",
  "tmpmail.net",
  "tmail.ai",
  "tmail.io",
  "tmpbox.net",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "trash-mail.com",
  "trashmail.io",
  // mailinator family
  "mailinator.com",
  "mailinator.net",
  "mailinator.org",
  "mailinater.com",
  // 10minute family
  "10minutemail.com",
  "10minutemail.net",
  "10minutemail.de",
  "10minutemail.co.uk",
  "10minemail.com",
  "minutemail.com",
  // guerrillamail family
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamail.biz",
  "guerrillamail.de",
  "guerrillamailblock.com",
  "spam4.me",
  "sharklasers.com",
  "grr.la",
  // yopmail
  "yopmail.com",
  "yopmail.net",
  "yopmail.fr",
  // others popular in India
  "ellbit.com",
  "fakeinbox.com",
  "getnada.com",
  "nada.email",
  "maildrop.cc",
  "mohmal.com",
  "moakt.com",
  "emailondeck.com",
  "incognitomail.com",
  "incognitomail.org",
  "disposablemail.com",
  "throwam.com",
  "anonbox.net",
  "mintemail.com",
  "burnermail.io",
  "wegwerfmail.de",
  "wegwerfmail.net",
  "spambox.us",
  "dropmail.me",
  "mytemp.email",
  "inboxbear.com",
  "spambog.com",
  "fakemail.net",
  "fakemailgenerator.com",
  "mailcatch.com",
  "mailnesia.com",
  "mailnull.com",
  "mailtemp.info",
  "mailtemporaire.fr",
  "tempinbox.com",
  "tempinbox.co.uk",
  "anonymbox.com",
  "anonaddy.com",
  "anonaddy.me",
  "duck.com", // DuckDuckGo Email Protection forwarders
  "simplelogin.io",
  "simplelogin.com",
  "33mail.com",
  "spamgourmet.com",
  "spamex.com",
  "yandex-team.ru", // commonly abused for trial-spam
]);

const DOMAIN_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

/**
 * Returns true when the email's domain (or any of its parent domains) is on
 * the blocklist. Case-insensitive. Returns false for malformed input — the
 * caller's email-format validation handles those.
 */
export function isDisposableEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  const match = email.toLowerCase().match(DOMAIN_RE);
  if (!match) return false;

  const segments = match[1].split(".");
  // Check the full domain plus each parent (foo.bar.baz → bar.baz, baz).
  for (let i = 0; i < segments.length - 1; i++) {
    const candidate = segments.slice(i).join(".");
    if (DISPOSABLE_DOMAINS.has(candidate)) return true;
  }
  return false;
}

export function getDisposableDomains(): readonly string[] {
  return Array.from(DISPOSABLE_DOMAINS);
}
