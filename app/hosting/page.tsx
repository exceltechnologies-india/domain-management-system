import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-config';
import { isPathDraftForPublic } from '@/lib/services/page-visibility';
import HostingPageClient from './HostingPageClient';

/**
 * Server gate: when this page is set to `draft` in Admin → Pages, the public
 * is redirected to the homepage while a logged-in admin still sees it
 * (preview). Published pages render the client component directly.
 */
export default async function HostingPage() {
  if (await isPathDraftForPublic('/hosting')) {
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'admin') redirect('/');
  }
  return <HostingPageClient />;
}
