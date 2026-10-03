import Image from 'next/image';
import Link from 'next/link';
import { homeUrl } from '@/lib/reseller-os';

interface LogoProps {
  className?: string;
  /**
   * Kept so existing call sites compile; the wordmark now always shows, because the
   * ResellerOS storefront mark is the round "A" PLUS the name (3 Oct 2026).
   */
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /**
   * Defaults to wherever "home" is — ResellerOS when it is the front door,
   * DMS's own `/` otherwise. Pass a value only for a logo that should go
   * somewhere else (the signed-in nav sends it to the panel).
   */
  href?: string;
  variant?: 'light' | 'dark';
}

/**
 * The brand mark — the SAME one the ResellerOS storefront shows (site Header/Chrome:
 * /anutech-digital-logo.png + "Anutech Digital", bold). Pawan, 3 Oct 2026: DMS is purely a
 * backend service for ResellerOS, so a customer must see ResellerOS branding wherever they
 * are; the old full "ANUTECH DIGITAL PVT LTD" image is no longer used here.
 */
export default function Logo({
  className = '',
  size = 'md',
  // Not a literal '/'. This same mark sits on the login, register,
  // forgot-password, reset-password and activate screens, and in the
  // integrated setup all five belong to ResellerOS's front door rather than
  // DMS's marketing homepage. One default covers them; a literal would have
  // to be found and changed in five places, and the fifth would be missed.
  href = homeUrl(),
  variant = 'light'
}: LogoProps) {
  /* The storefront header uses a 34px mark with 16–18px bold text; the sizes stay
     close to that so the panel and the shop read as one product. */
  const markPx = { sm: 26, md: 30, lg: 34, xl: 36 }[size];
  const textClass = { sm: 'text-[15px]', md: 'text-base', lg: 'text-lg', xl: 'text-lg' }[size];

  const logoElement = (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <Image
        src="/anutech-digital-logo.png"
        alt=""
        width={markPx}
        height={markPx}
        className="shrink-0 rounded-full object-contain"
        priority
      />
      <span className={`font-bold tracking-tight ${variant === 'dark' ? 'text-white' : 'text-ink'} ${textClass}`}>
        Anutech Digital
      </span>
    </div>
  );

  if (href) {
    return (
      <Link href={href} aria-label="Anutech Digital">
        {logoElement}
      </Link>
    );
  }

  return logoElement;
}
