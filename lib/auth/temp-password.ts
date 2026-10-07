import { randomInt } from "node:crypto";

/**
 * One-time password for a new Customer Portal account (Pawan, 7 Oct 2026: "send the one time
 * generated password for direct login, then let the user generate their own password").
 *
 * Three groups of four, e.g. "Kp7m-Xq3a-Wz9t": easy to read off an email and type on a phone.
 * No look-alike characters (0/O, 1/l/I). Each group has an upper case letter, a lower case
 * letter and a digit, so it also passes the portal's own strength rule. It is only good for the
 * first sign-in: the account is marked mustChangePassword and the portal asks for a new one.
 */
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGIT = "23456789";
const ALL = UPPER + LOWER + DIGIT;

const pick = (set: string) => set[randomInt(set.length)];

function group(): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(ALL)];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function generateTempPassword(): string {
  return [group(), group(), group()].join("-");
}
