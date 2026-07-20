import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-config';
import { isPathDraftForPublic } from '@/lib/services/page-visibility';
import DomainHome from '@/components/marketing/DomainHome';

/**
 * The domain-focused landing (former homepage). Managed via Admin → Pages;
 * when drafted, the public is redirected to the homepage while admins preview.
 */
export default async function DomainsHomePage() {
  if (await isPathDraftForPublic('/domains-home')) {
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'admin') redirect('/');
  }
  return <DomainHome />;
}
