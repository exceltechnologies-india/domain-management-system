/**
 * Shared helpers + types + constants used by the auth-config submodules.
 */

// Google OAuth profile includes given_name / family_name not in the base Profile type
export interface GoogleProfile {
  given_name?: string;
  family_name?: string;
  email?: string;
  name?: string;
  picture?: string;
  sub?: string;
}

export interface GithubProfile {
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
  id?: number;
}

// Extract first/last name from any social provider's profile object.
// `profile` and `user` shapes vary per provider (Google, GitHub, Facebook);
// we read the union of fields defensively, so a structural shape is enough.
export function extractSocialName(
  provider: string,
  profile: unknown,
  user: { name?: string | null }
): { firstName: string; lastName: string } {
  if (provider === "google") {
    return {
      firstName: (profile as GoogleProfile)?.given_name || user.name?.split(" ")[0] || "",
      lastName: (profile as GoogleProfile)?.family_name || user.name?.split(" ").slice(1).join(" ") || "",
    };
  }
  if (provider === "github") {
    const displayName = (profile as GithubProfile)?.name || (profile as GithubProfile)?.login || user.name || "";
    const parts = displayName.split(" ");
    return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
  }
  // Facebook and others: full name only
  const parts = (user.name || "").split(" ");
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
}

export const SOCIAL_PROVIDERS = ["google", "facebook", "github"];

// Mirror NextAuth's own useSecureCookies logic so our explicit config stays in sync.
export const useSecureCookies = process.env.NEXTAUTH_URL?.startsWith("https://") ?? false;
