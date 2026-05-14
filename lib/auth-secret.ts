if (!process.env.NEXTAUTH_SECRET) {
  throw new Error("NEXTAUTH_SECRET environment variable is not set");
}

export const AUTH_SECRET = process.env.NEXTAUTH_SECRET.trim();
