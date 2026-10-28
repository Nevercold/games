import { DEFAULT_BRANDING, type Branding } from '#shared/branding'

export function useBranding() {
  return useState<Branding>('branding', () => ({ ...DEFAULT_BRANDING }))
}
