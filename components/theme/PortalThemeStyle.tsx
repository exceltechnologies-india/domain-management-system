/**
 * Renders ResellerOS's theme as CSS custom properties for the Customer Portal (`.ros-theme`, set on
 * UserLayout's root). Server component: the colours arrive in the first HTML, with no flash.
 * See lib/theme/theme.ts.
 */
import { fetchPortalTheme } from '@/lib/theme/fetch-theme';
import { themeToCss } from '@/lib/theme/theme';

export default async function PortalThemeStyle() {
  const { theme, source } = await fetchPortalTheme();
  // Safe to inline: every value passed parseTheme's strict colour patterns, or is the bundled default.
  return (
    <style
      id="portal-theme"
      data-source={source}
      data-version={theme.version}
      dangerouslySetInnerHTML={{ __html: themeToCss(theme) }}
    />
  );
}
