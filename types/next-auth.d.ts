import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role: "admin" | "user" | "reseller";
      profileCompleted?: boolean;
      provider?: string;
      passwordExpired?: boolean;
      mustChangePassword?: boolean;
    };
  }

  interface User {
    id: string;
    role: "admin" | "user" | "reseller";
    profileCompleted?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: "admin" | "user" | "reseller";
    profileCompleted?: boolean;
    provider?: string;
    passwordExpired?: boolean;
    /** Signed in with a one-time password; must choose their own first (7 Oct 2026). */
    mustChangePassword?: boolean;
  }
}
