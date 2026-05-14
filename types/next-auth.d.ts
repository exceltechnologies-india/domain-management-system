import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role: "admin" | "user";
      profileCompleted?: boolean;
      provider?: string;
      passwordExpired?: boolean;
    };
  }

  interface User {
    id: string;
    role: "admin" | "user";
    profileCompleted?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: "admin" | "user";
    profileCompleted?: boolean;
    provider?: string;
    passwordExpired?: boolean;
  }
}
