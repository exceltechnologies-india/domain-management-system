/**
 * Zoho Books organization-level operations.
 */

import axios from 'axios';
import { serverLogger } from '../server-logger';
import type { ZohoBooksService } from '../zohobooks';

/**
 * Get primary organization details to check plan status
 */
export async function getOrganizationDetails(self: ZohoBooksService): Promise<any | null> {
  if (!self._hasRefreshToken()) return null;

  try {
    const headers = await self._getHeaders();
    // Zoho Books API to list organizations
    const response = await self._idempotentRetry(() =>
        axios.get(`${self._baseUrl}/organizations`, { headers })
    );

    if (response.data.code === 0 && response.data.organizations) {
      // Find the organization matching our orgId, or fallback to the first one
      const org = response.data.organizations.find((o: any) =>
          String(o.organization_id) === String(self._orgId)
      ) || response.data.organizations[0];

      return org;
    }
    return null;
  } catch (error: any) {
    serverLogger.error('[ZohoBooks] Failed to fetch organization details', error.response?.data || error.message);
    return null;
  }
}
