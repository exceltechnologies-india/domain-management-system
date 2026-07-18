import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-config';
import { isPathDraftForPublic } from '@/lib/services/page-visibility';
import ContactPageClient from './ContactPageClient';

/**
 * Server gate: when this page is set to `draft` in Admin → Pages, the public
 * is redirected to the homepage while a logged-in admin still sees it.
 */
export default async function ContactPage() {
  if (await isPathDraftForPublic('/contact')) {
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'admin') redirect('/');
  }
  return <ContactPageClient />;
}
