/**
 * Public discovery metadata for the unauthenticated arrival page.
 *
 * The deployment origin is deliberately injected by the server at request
 * time. Builds are portable artefacts, while ATOMA_VIZ_PUBLIC_ORIGIN is the
 * operator-owned canonical identity already used by authentication.
 */
export const SEO_TITLE = 'Atoma — Inspectable AI Agent Orchestration';
export const SEO_DESCRIPTION =
  'Atoma orchestrates specialized AI agents across planning, execution, and verification for cost-aware, inspectable software delivery.';
export const SEO_SOCIAL_IMAGE_PATH = '/og-card.png';

const SEO_SLOT = '<!-- ATOMA_DEPLOYMENT_SEO -->';
const SEO_BLOCK = /\s*<!-- ATOMA_SEO_START -->[\s\S]*?<!-- ATOMA_SEO_END -->/;

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function replaceTitle(html: string, title: string): string {
  return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeAttribute(title)}</title>`);
}

function seoBlock(publicOrigin: URL | null): string {
  if (!publicOrigin) {
    return [
      '<!-- ATOMA_SEO_START -->',
      '  <meta name="robots" content="noindex, nofollow" />',
      '<!-- ATOMA_SEO_END -->',
    ].join('\n');
  }

  const canonical = new URL('/', publicOrigin).href;
  const socialImage = new URL(SEO_SOCIAL_IMAGE_PATH, publicOrigin).href;
  const structuredData = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': ['SoftwareApplication', 'WebApplication'],
    name: 'Atoma',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web',
    description: SEO_DESCRIPTION,
    url: canonical,
    image: socialImage,
    sameAs: ['https://github.com/mgtf/atoma'],
  }).replaceAll('<', '\\u003c');

  return [
    '<!-- ATOMA_SEO_START -->',
    `  <meta name="description" content="${escapeAttribute(SEO_DESCRIPTION)}" />`,
    '  <meta name="author" content="Atoma" />',
    '  <meta name="robots" content="index, follow, max-image-preview:large" />',
    `  <link rel="canonical" href="${escapeAttribute(canonical)}" />`,
    '  <meta property="og:type" content="website" />',
    '  <meta property="og:site_name" content="Atoma" />',
    '  <meta property="og:locale" content="en_US" />',
    `  <meta property="og:title" content="${escapeAttribute(SEO_TITLE)}" />`,
    `  <meta property="og:description" content="${escapeAttribute(SEO_DESCRIPTION)}" />`,
    `  <meta property="og:url" content="${escapeAttribute(canonical)}" />`,
    `  <meta property="og:image" content="${escapeAttribute(socialImage)}" />`,
    '  <meta property="og:image:type" content="image/png" />',
    '  <meta property="og:image:width" content="1200" />',
    '  <meta property="og:image:height" content="630" />',
    '  <meta property="og:image:alt" content="Atoma — frontier reasoning once per task" />',
    '  <meta name="twitter:card" content="summary_large_image" />',
    `  <meta name="twitter:title" content="${escapeAttribute(SEO_TITLE)}" />`,
    `  <meta name="twitter:description" content="${escapeAttribute(SEO_DESCRIPTION)}" />`,
    `  <meta name="twitter:image" content="${escapeAttribute(socialImage)}" />`,
    '  <meta name="twitter:image:alt" content="Atoma — frontier reasoning once per task" />',
    `  <script type="application/ld+json">${structuredData}</script>`,
    '<!-- ATOMA_SEO_END -->',
  ].join('\n');
}

/** Inject one idempotent metadata block into either source or built HTML. */
export function injectAppShellSeo(html: string, publicOrigin: URL | null): string {
  const withoutPreviousBlock = html.replace(SEO_BLOCK, '');
  const block = seoBlock(publicOrigin);
  const withMetadata = withoutPreviousBlock.includes(SEO_SLOT)
    ? withoutPreviousBlock.replace(SEO_SLOT, block)
    : withoutPreviousBlock.replace(/<\/head>/i, `${block}\n</head>`);
  return publicOrigin ? replaceTitle(withMetadata, SEO_TITLE) : withMetadata;
}

export function robotsTxt(publicOrigin: URL | null): string {
  if (!publicOrigin) return 'User-agent: *\nDisallow: /\n';
  const sitemap = new URL('/sitemap.xml', publicOrigin).href;
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /auth/',
    'Disallow: /webhooks/',
    `Sitemap: ${sitemap}`,
    '',
  ].join('\n');
}

export function sitemapXml(publicOrigin: URL): string {
  const canonical = escapeAttribute(new URL('/', publicOrigin).href);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${canonical}</loc>`,
    '  </url>',
    '</urlset>',
    '',
  ].join('\n');
}
