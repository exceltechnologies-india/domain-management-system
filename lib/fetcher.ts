/**
 * SWR fetcher — sends the NextAuth session cookie via credentials:"include".
 * All dashboard useSWR calls use this.
 *
 * The previous shape also attached a Bearer token from
 * safeLocalStorage.getItem("token"), but no auth path writes that key any
 * more (credentials login goes through NextAuth, and the activate/register
 * stub writes are themselves dead). The cookie carries auth on its own.
 */
export async function fetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });

  if (!res.ok) {
    const err = new Error('API request failed') as Error & { status: number; info: unknown };
    err.status = res.status;
    err.info = await res.json().catch(() => ({}));
    throw err;
  }

  return res.json() as Promise<T>;
}
