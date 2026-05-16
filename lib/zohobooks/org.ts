/**
 * Zoho Books organization-level operations.
 */

import axios from 'axios';
import { serverLogger } from '../server-logger';
import type { ZohoBooksService } from '../zohobooks';
import type { ZohoOrganization } from './types';
import { unwrapZohoError } from './types';

/**
 * Get primary organization details to check plan status
 */
export async function getOrganizationDetails(self: ZohoBooksService): Promise<ZohoOrganization | null> {
  if (!self._hasRefreshToken()) return null;

  try {
    const headers = await self._getHeaders();
    // Zoho Books API to list organizations
    const response = await self._idempotentRetry(() =>
        axios.get(`${self._baseUrl}/organizations`, { headers })
    );

    if (response.data.code === 0 && response.data.organizations) {
      const orgs = response.data.organizations as ZohoOrganization[];
      // Find the organization matching our orgId, or fallback to the first one
      const org = orgs.find((o) =>
          String(o.organization_id) === String(self._orgId)
      ) || orgs[0];

      return org;
    }
    return null;
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Failed to fetch organization details', u.data || u.message);
    return null;
  }
}
