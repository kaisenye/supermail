import type { OAuthProvider } from './auth.js'

/**
 * OAuth client ids are baked in at build time from MAIN_VITE_* variables
 * (electron-vite loads .env / .env.local into import.meta.env for main).
 * Google's "Desktop app" secret is not confidential — Google documents that
 * installed apps cannot keep one — but its token endpoint still requires it.
 */
export function oauthClient(
  provider: OAuthProvider
): { clientId: string; clientSecret?: string } | null {
  if (provider === 'google') {
    const clientId = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID
    const clientSecret = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET
    return clientId ? { clientId, clientSecret } : null
  }
  const clientId = import.meta.env.MAIN_VITE_MS_CLIENT_ID
  return clientId ? { clientId } : null
}
