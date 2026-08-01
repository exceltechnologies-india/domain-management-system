/**
 * Shared types for the /admin/dns-management page.
 *
 * Split out of page.tsx (maintainability refactor) — pure relocation, no
 * behavioural change.
 */

export interface Domain {
  id: string;
  name: string;
  price: number;
  currency: string;
  registrationPeriod: number;
  status: string;
  expiresAt: string;
  resellerClubOrderId?: string;
  resellerClubCustomerId?: string;
  resellerClubContactId?: string;
  dnsActivated?: boolean;
  dnsActivatedAt?: string;
  customerName?: string;
  customerEmail?: string;
  orderId?: string;
}

export interface DNSRecord {
  id: string;
  type: string;
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

export interface NameserverInfo {
  nameservers: string[];
  method: string;
  whoisData?: {
    registrar: string;
    creationDate: string;
    expirationDate: string;
    lastUpdated: string;
    status: string;
  };
}
