import { safeLocalStorage } from '@/lib/storage';

/**
 * SWR fetcher — attaches the Bearer token from localStorage (credential login)
 * and sends cookies (NextAuth session). All dashboard useSWR calls use this.
 */
export async function fetcher<T = unknown>(url: string): Promise<T> {
  const token = safeLocalStorage.getItem('token');
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers, credentials: 'include' });

  if (!res.ok) {
    const err = new Error('API request failed') as Error & { status: number; info: unknown };
    err.status = res.status;
    err.info = await res.json().catch(() => ({}));
    throw err;
  }

  return res.json() as Promise<T>;
}
