const MOBILE_APP_HOSTS = new Set([
  'mobile.buildtrack.newurbandev.com',
  'm.buildtrack.newurbandev.com',
]);

export const MOBILE_APP_ORIGIN = 'https://mobile.buildtrack.newurbandev.com';
export const DESKTOP_APP_ORIGIN = 'https://buildtrack.newurbandev.com';

function currentHostname(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.location.hostname.toLowerCase();
}

function splitPathAndSuffix(path: string): { pathname: string; suffix: string } {
  const match = path.match(/^([^?#]*)(.*)$/);
  return {
    pathname: match?.[1] || '/',
    suffix: match?.[2] || '',
  };
}

export function isMobileAppHost(hostname = currentHostname()): boolean {
  return MOBILE_APP_HOSTS.has(hostname.toLowerCase());
}

export function isLegacyMobilePath(pathname = window.location.pathname): boolean {
  return pathname === '/mobile' || pathname.startsWith('/mobile/');
}

export function isLegacyContractorAppPath(pathname = window.location.pathname): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

export function normalizeMobilePath(path = '/'): string {
  const { pathname, suffix } = splitPathAndSuffix(path || '/');
  let normalized = pathname || '/';

  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '/mobile' || normalized === '/app' || normalized === '/app/home') {
    normalized = '/';
  } else if (normalized.startsWith('/mobile/')) {
    normalized = normalized.slice('/mobile'.length) || '/';
  } else if (normalized === '/app/projects') {
    normalized = '/projects';
  } else if (normalized.startsWith('/app/project/')) {
    normalized = normalized.replace('/app/project', '/project');
  }

  return `${normalized}${suffix}`;
}

export function mobilePath(path = '/'): string {
  const normalized = normalizeMobilePath(path);
  const { pathname, suffix } = splitPathAndSuffix(normalized);

  if (isMobileAppHost()) {
    return normalized;
  }

  return pathname === '/'
    ? `/mobile${suffix}`
    : `/mobile${pathname}${suffix}`;
}

export function legacyMobilePathToMobileHostPath(path = window.location.pathname): string {
  return normalizeMobilePath(path);
}

export function mobileExternalUrl(path = '/'): string {
  return `${MOBILE_APP_ORIGIN}${normalizeMobilePath(path)}`;
}
