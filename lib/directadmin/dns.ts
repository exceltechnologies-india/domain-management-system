/**
 * DirectAdmin DNS operations.
 */

import axios from 'axios';
import { serverLogger } from '@/lib/server-logger';
import {
  ADMIN_USER,
  API_KEY,
  DA_URL,
  DEFAULT_TIMEOUT_MS,
  DirectAdminError,
  executeRequest,
  parseDAError,
  parseResponseData,
  validateUsername,
} from './client';

/**
 * Fetch all DNS records for a domain
 */
export async function getDNSRecords(username: string, domain: string): Promise<any[]> {
  validateUsername(username);

  return executeRequest(
    async () => {
      const response = await axios.get(`${DA_URL}/CMD_API_DNS_CONTROL`, {
        auth: { username: `${ADMIN_USER}|${username}`, password: API_KEY as string },
        timeout: DEFAULT_TIMEOUT_MS,
      });

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
         throw new DirectAdminError(parseDAError(response.data), 'GetDNSRecords', 200, response.data);
      }

      serverLogger.info(`DA DNS Response [${domain}]:`, typeof response.data === 'object' ? JSON.stringify(response.data) : response.data);

      // Check if response is a raw BIND zone file (typical with action=view on some DA versions)
      if (typeof response.data === 'string' && (response.data.includes('$TTL') || response.data.includes('IN\tNS') || response.data.includes('IN NS'))) {
          const lines = response.data.split('\n');
          const records: any[] = [];

          for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('$')) continue;

              // Regex: Name [TTL] IN Type Value
              const match = trimmed.match(/^(\S+)\s+(?:(\d+)\s+)?IN\s+(\w+)\s+(.+)$/);

              if (match) {
                  records.push({
                      name: match[1],
                      type: match[3],
                      value: match[4],
                      ttl: match[2]
                  });
              }
          }
          return records;
      }

      const data = parseResponseData(response.data);
      const records: any[] = [];

      // Parse the numbered response fields (name0, value0, type0, etc.)
      // We scan keys until we find no more 'nameN'
      let i = 0;
      while (data[`name${i}`] !== undefined) {
        records.push({
          name: data[`name${i}`],
          value: data[`value${i}`],
          type: data[`type${i}`],
          ttl: data[`ttl${i}`],
          // Key is often needed for deletion if provided, otherwise we construct the select string
          key: data[`key${i}`] || `name=${data[`name${i}`]}&value=${data[`value${i}`]}`
        });
        i++;
      }

      return records;
    },
    `GetDNSRecords-${domain}`
  );
}

/**
 * Delete specific DNS records
 */
export async function deleteDNSRecords(username: string, domain: string, records: any[]): Promise<any> {
  if (!records || records.length === 0) return;

  return executeRequest(
    async () => {
      const payload = new URLSearchParams({
        domain,
        action: 'select',
      });

      records.forEach((record, index) => {
        // DirectAdmin deletion uses 'selectN' param with the encoded record value
        // Often it handles 'name=foo&value=bar' as the value
        const selectValue = record.key || `name=${record.name}&value=${record.value}`;
        payload.append(`select${index}`, selectValue);
      });

      const response = await axios.post(
        `${DA_URL}/CMD_API_DNS_CONTROL`,
        payload.toString(),
        {
          auth: { username: `${ADMIN_USER}|${username}`, password: API_KEY as string },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
         throw new DirectAdminError(parseDAError(response.data), 'DeleteDNSRecords', 200, response.data);
      }

      serverLogger.info(`DirectAdmin: Deleted ${records.length} DNS records for ${domain}`);
      return response.data;
    },
    `DeleteDNSRecords-${domain}`
  );
}

/**
 * Add a single DNS record
 */
export async function addDNSRecord(username: string, domain: string, type: string, value: string, name: string = ''): Promise<any> {
  return executeRequest(
    async () => {
      const payload = new URLSearchParams({
        domain,
        action: 'add',
        type,
        name: name || domain, // If name is empty, it usually defaults to domain root '@', or explicit domain
        value,
        ttl: '14400'
      });

      // For NS records at root, name should be the domain itself usually, or encoded as such
      if (type === 'NS' && !name) {
           payload.set('name', domain + '.');
      }

      const response = await axios.post(
        `${DA_URL}/CMD_API_DNS_CONTROL`,
        payload.toString(),
        {
          auth: { username: `${ADMIN_USER}|${username}`, password: API_KEY as string },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );

      // Check for DA specific error in 200 OK response
      if (response.data && (response.data.error === "1" || response.data.startsWith("error=1"))) {
         throw new DirectAdminError(parseDAError(response.data), 'AddDNSRecord', 200, response.data);
      }

      return response.data;
    },
    `AddDNSRecord-${domain}-${type}`
  );
}

/**
 * Update DNS nameservers for a domain
 * Completely replaces existing NS records with new ones
 */
export async function updateDNSNameservers(username: string, domain: string, nameservers: string[]): Promise<any> {
  // DISABLED: DNS sync is now handled by purchase type separation
  throw new Error("Automatic DNS syncing is disabled. DNS authority is determined at purchase time.");
}
