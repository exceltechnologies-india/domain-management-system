import { headers } from "next/headers";
import { getTrackingConfig, hasAnyTag } from "@/lib/services/tracking";
import SpaPageViews from "@/components/SpaPageViews";

/**
 * Renders analytics / marketing tags site-wide.
 *
 * This is the "safe injection" half of the tracking feature (see
 * lib/services/tracking.ts for the design). It NEVER renders admin-supplied
 * markup — it emits FIRST-PARTY, official provider snippets parameterised by
 * the validated IDs read from Settings, each carrying the per-request CSP
 * nonce so they execute under the strict nonce-based policy.
 *
 * Server component: reads the resolved config (cached) + the nonce/pathname
 * the middleware forwarded via request headers. Returns null (nothing) when
 * tracking is disabled, no provider is configured, or the current route is an
 * admin/dashboard page and "load on admin" is off.
 */
export default async function TrackingScripts() {
  const config = await getTrackingConfig();
  if (!hasAnyTag(config)) return null;

  const h = await headers();
  const nonce = h.get("x-nonce") ?? undefined;
  const pathname = h.get("x-pathname") ?? "";

  // Analytics normally shouldn't count staff sessions. Skip on admin +
  // dashboard unless the operator explicitly opted in.
  const isStaffRoute =
    pathname.startsWith("/admin") || pathname.startsWith("/dashboard");
  if (isStaffRoute && !config.loadOnAdmin) return null;

  const { ga4Id, gtmId, metaPixelId, googleAdsId } = config;

  // GA4 + Google Ads both ride gtag.js — load the loader once, then a
  // `config` call per id.
  const gtagLoaderId = ga4Id || googleAdsId;
  const gtagConfigLines = [
    ga4Id && `gtag('config', ${JSON.stringify(ga4Id)});`,
    googleAdsId && `gtag('config', ${JSON.stringify(googleAdsId)});`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      {/* Google Analytics 4 / Google Ads (gtag.js) */}
      {gtagLoaderId && (
        <>
          <script
            async
            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gtagLoaderId)}`}
            nonce={nonce}
          />
          <script
            nonce={nonce}
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());\n${gtagConfigLines}`,
            }}
          />
        </>
      )}

      {/* Google Tag Manager */}
      {gtmId && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${JSON.stringify(gtmId)});`,
          }}
        />
      )}

      {/* Meta / Facebook Pixel */}
      {metaPixelId && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${JSON.stringify(metaPixelId)});fbq('track','PageView');`,
          }}
        />
      )}

      {/* noscript fallbacks — GTM iframe + Meta Pixel image beacon */}
      {gtmId && (
        <noscript
          dangerouslySetInnerHTML={{
            __html: `<iframe src="https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(gtmId)}" height="0" width="0" style="display:none;visibility:hidden"></iframe>`,
          }}
        />
      )}
      {metaPixelId && (
        <noscript
          dangerouslySetInnerHTML={{
            __html: `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${encodeURIComponent(metaPixelId)}&ev=PageView&noscript=1" alt="" />`,
          }}
        />
      )}

      {/* Client-side PageView on SPA route changes (opt-out via admin toggle). */}
      <SpaPageViews
        enabled={config.spaPageViews}
        ga4Id={ga4Id}
        googleAdsId={googleAdsId}
        metaPixelId={metaPixelId}
      />
    </>
  );
}
