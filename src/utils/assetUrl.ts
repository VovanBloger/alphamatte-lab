/**
 * Resolve relative asset URLs cleanly whether hosted at domain root ('/') or subpath ('/lab/').
 */
export function resolveAssetUrl(url: string | undefined): string {
  if (!url) return '';
  if (
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('http://') ||
    url.startsWith('https://')
  ) {
    return url;
  }
  const clean = url.replace(/^\/+/, '');
  const path = typeof window !== 'undefined' ? window.location.pathname : '/';
  const prefix = path.endsWith('/') ? path : path + '/';
  return `${prefix}${clean}`;
}
