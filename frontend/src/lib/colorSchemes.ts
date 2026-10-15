export type ColorSchemeId = '01' | '07' | '08' | '02';
export const DEFAULT_COLOR_SCHEME: ColorSchemeId = '07';
export const COLOR_SCHEMES = [
  { id: '01', name: 'Porcelain Blue', mode: 'Light', description: 'Crisp white surfaces and a focused blue accent.',
    colors: { page: '#EEF2F7', surface: '#FFFFFF', raised: '#F4F6F9', nav: '#FFFFFF', header: '#F8FAFC', input: '#FFFFFF', control: '#F0F3F7', selected: '#E5EDFC', text: '#1D2939', muted: '#596B80', border: '#CDD6E2', accent: '#2458BA', onaccent: '#FFFFFF', success: '#276747', danger: '#A83C43', warning: '#79592F' } },
  { id: '07', name: 'Midnight Navy', mode: 'Dark', description: 'Deep navy surfaces with clear, cool blue contrast.',
    colors: { page: '#0E1A2B', surface: '#17283D', raised: '#1D334D', nav: '#142338', header: '#1D3047', input: '#101F31', control: '#263D56', selected: '#304F70', text: '#EBF3FC', muted: '#A9BED6', border: '#425D7A', accent: '#9BC8FF', onaccent: '#152D49', success: '#9DCFB5', danger: '#EDABB7', warning: '#E3C398' } },
  { id: '08', name: 'Carbon Silver', mode: 'Dark', description: 'Neutral charcoal and restrained silver accents.',
    colors: { page: '#191A1C', surface: '#242628', raised: '#2D3033', nav: '#202224', header: '#2C2F32', input: '#1B1D1F', control: '#34383C', selected: '#454C53', text: '#F0F2F4', muted: '#B5BDC6', border: '#4D555F', accent: '#D0D8E2', onaccent: '#252D38', success: '#ADCFB9', danger: '#E4ABB2', warning: '#DECAA8' } },
  { id: '02', name: 'Warm Ivory', mode: 'Light', description: 'Soft ivory surfaces and a warm, understated accent.',
    colors: { page: '#F3F0E9', surface: '#FFFEFA', raised: '#F8F5EE', nav: '#FFFEFA', header: '#EEEAE1', input: '#FFFFFF', control: '#EDE8DD', selected: '#EFE4D1', text: '#302E2A', muted: '#6E6558', border: '#D8D0C2', accent: '#79592F', onaccent: '#FFFFFF', success: '#416343', danger: '#A44242', warning: '#79592F' } },
] as const;

export function normalizeColorScheme(value: unknown): ColorSchemeId {
  return COLOR_SCHEMES.find(scheme => scheme.id === value)?.id ?? DEFAULT_COLOR_SCHEME;
}

export function applyColorScheme(value: unknown) {
  const scheme = COLOR_SCHEMES.find(item => item.id === normalizeColorScheme(value))!;
  const root = document.documentElement;
  root.dataset.btScheme = scheme.id;
  root.style.colorScheme = scheme.mode.toLowerCase();
  for (const [token, color] of Object.entries(scheme.colors)) root.style.setProperty('--theme-' + token, color);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', scheme.colors.page);
}
