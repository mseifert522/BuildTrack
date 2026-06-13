const MOBILE_APP_HOSTS = new Set([
  'mobile.buildtrack.newurbandev.com',
  'm.buildtrack.newurbandev.com',
]);

const DESKTOP_APP_HOSTS = new Set([
  'buildtrack.newurbandev.com',
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

export function isDesktopAppHost(hostname = currentHostname()): boolean {
  return DESKTOP_APP_HOSTS.has(hostname.toLowerCase());
}

export function isBuildTrackAppHost(hostname = currentHostname()): boolean {
  return isMobileAppHost(hostname) || isDesktopAppHost(hostname);
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

  if (normalized === '/mobile' || normalized === '/app' || normalized === '/app/home' || normalized === '/app/invoice') {
    normalized = '/';
  } else if (normalized.startsWith('/mobile/')) {
    normalized = normalized.slice('/mobile'.length) || '/';
  } else if (normalized === '/app/projects') {
    normalized = '/projects';
  } else if (normalized.startsWith('/app/project/')) {
    normalized = normalized.replace('/app/project', '/project');
  } else if (normalized.startsWith('/app/')) {
    normalized = '/';
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

export function mobileHostPathFor(path = '/'): string {
  const normalized = normalizeMobilePath(path);
  const { pathname, suffix } = splitPathAndSuffix(normalized);

  if (pathname === '/' || pathname === '/dashboard' || pathname === '/projects') return `/${suffix}`;
  if (pathname === '/desktop/photos' || pathname === '/photos') return `/photos${suffix}`;
  if (pathname === '/punch-list') return `/${suffix}`;

  const invoiceBuilderMatch = pathname.match(/^\/projects\/([^/]+)\/invoices(?:\/new|\/[^/]+)?$/);
  if (invoiceBuilderMatch) return `/project/${invoiceBuilderMatch[1]}/invoice${suffix}`;

  const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) return `/project/${projectMatch[1]}${suffix}`;

  return `${pathname}${suffix}`;
}

export function desktopHostPathFor(path = '/'): string {
  const normalized = normalizeMobilePath(path);
  const { pathname, suffix } = splitPathAndSuffix(normalized);

  if (pathname === '/' || pathname === '/app' || pathname === '/app/home') return `/dashboard${suffix}`;
  if (pathname === '/add-project') return `/projects${suffix}`;
  if (pathname === '/desktop/photos') return `/photos${suffix}`;

  const mobileProjectMatch = pathname.match(/^\/project\/([^/]+)(?:\/([^/]+))?$/);
  if (mobileProjectMatch) {
    const section = mobileProjectMatch[2];
    const hash = section && !suffix.includes('#') ? `#${section}` : '';
    return `/projects/${mobileProjectMatch[1]}${suffix}${hash}`;
  }

  return `${pathname}${suffix}`;
}

export function mobileExternalUrl(path = '/'): string {
  return `${MOBILE_APP_ORIGIN}${mobileHostPathFor(path)}`;
}

export function desktopExternalUrl(path = '/'): string {
  return `${DESKTOP_APP_ORIGIN}${desktopHostPathFor(path)}`;
}
