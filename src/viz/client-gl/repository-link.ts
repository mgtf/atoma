type OpenWindow = (url: string, target: string, features: string) => Window | null;

/** Only product-owned GitHub repository URLs may leave the application. */
export function githubRepositoryHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
    if (url.pathname.split('/').filter(Boolean).length < 2) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Open a validated repository in a separate, opener-isolated tab. */
export function openGitHubRepository(
  value: string | null | undefined,
  openWindow: OpenWindow = (url, target, features) => window.open(url, target, features)
): boolean {
  const href = githubRepositoryHref(value);
  if (!href) return false;
  openWindow(href, '_blank', 'noopener,noreferrer');
  return true;
}
