// Better-auth client for the Kimaki website.
// Used for Discord OAuth login. Omits baseURL since client and server
// share the same domain (kimaki.dev).
'use client'

import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient()

export const { signIn, signOut, useSession } = authClient

/**
 * Initiates Discord OAuth login, redirecting back to the given URL after auth.
 * If no callbackURL is provided, defaults to the current page.
 */
export function loginWithDiscord(callbackURL?: string) {
  return signIn.social({
    provider: 'discord',
    callbackURL: callbackURL ?? window.location.href,
  })
}
