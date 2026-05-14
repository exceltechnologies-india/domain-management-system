import CenteredLoading from '@/components/CenteredLoading';

/**
 * Global loading component for Next.js route transitions
 * Automatically centers content on all screen sizes
 */
export default function Loading() {
  return <CenteredLoading message="Loading page" size="lg" fullScreen={true} />;
}
