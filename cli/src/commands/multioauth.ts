/**
 * CLI commands for multi-provider OAuth account management.
 * Mounted via goke .use() in cli.ts under the `multioauth` namespace.
 * Manages Anthropic and OpenAI OAuth account rotation pools.
 */

import { goke } from 'goke'
import {
  accountLabel as anthropicAccountLabel,
  accountsFilePath as anthropicAccountsFilePath,
  authFilePath,
  getCurrentAnthropicAccount,
  loadAccountStore as loadAnthropicAccountStore,
  removeAccount as removeAnthropicAccount,
} from '../anthropic-auth-state.js'
import {
  accountLabel as openaiAccountLabel,
  openaiAccountsFilePath,
  getCurrentOpenAIAccount,
  loadOpenAIAccountStore,
  removeOpenAIAccount,
  saveOpenAIAccountStore,
} from '../openai-auth-state.js'

const EXIT_NO_RESTART = 64

function resolveAccountIndex(
  indexOrEmail: string,
  accounts: { email?: string }[],
): number {
  const value = Number(indexOrEmail)
  if (Number.isInteger(value) && value >= 1) {
    return value - 1
  }
  const email = indexOrEmail.trim().toLowerCase()
  if (!email) return -1
  return accounts.findIndex((account) => {
    return account.email?.toLowerCase() === email
  })
}

const multioauth = goke()

multioauth
  .command('multioauth list', 'List all OAuth accounts across all providers')
  .action(async () => {
    const anthropicStore = await loadAnthropicAccountStore()
    const openaiStore = await loadOpenAIAccountStore()

    console.log('Anthropic OAuth accounts:')
    if (anthropicStore.accounts.length === 0) {
      console.log('  (none)')
    } else {
      anthropicStore.accounts.forEach((account, index) => {
        const active = index === anthropicStore.activeIndex ? '*' : ' '
        console.log(`  ${active} ${index + 1}. ${anthropicAccountLabel(account)}`)
      })
    }

    console.log('')
    console.log('OpenAI OAuth accounts:')
    if (openaiStore.accounts.length === 0) {
      console.log('  (none)')
    } else {
      openaiStore.accounts.forEach((account, index) => {
        const active = index === openaiStore.activeIndex ? '*' : ' '
        console.log(`  ${active} ${index + 1}. ${openaiAccountLabel(account)}`)
      })
    }

    process.exit(0)
  })

// --- Anthropic subcommands ---

multioauth
  .command('multioauth anthropic list', 'List stored Anthropic OAuth accounts used for automatic rotation')
  .action(async () => {
    const store = await loadAnthropicAccountStore()
    console.log(`Store: ${anthropicAccountsFilePath()}`)
    if (store.accounts.length === 0) {
      console.log('No Anthropic OAuth accounts configured.')
      process.exit(0)
    }

    store.accounts.forEach((account, index) => {
      const active = index === store.activeIndex ? '*' : ' '
      console.log(`${active} ${index + 1}. ${anthropicAccountLabel(account)}`)
    })

    process.exit(0)
  })

multioauth
  .command('multioauth anthropic current', 'Show the current Anthropic OAuth account being used')
  .action(async () => {
    const current = await getCurrentAnthropicAccount()
    console.log(`Store: ${anthropicAccountsFilePath()}`)
    console.log(`Auth: ${authFilePath()}`)

    if (!current) {
      console.log('No active Anthropic OAuth account configured.')
      process.exit(0)
    }

    const lines: string[] = []
    lines.push(`Current: ${anthropicAccountLabel(current.account || current.auth, current.index)}`)

    if (current.account?.email) {
      lines.push(`Email: ${current.account.email}`)
    } else {
      lines.push('Email: unavailable')
    }

    if (current.account?.accountId) {
      lines.push(`Account ID: ${current.account.accountId}`)
    }

    if (!current.account) {
      lines.push('Rotation pool entry: not found')
    }

    console.log(lines.join('\n'))
    process.exit(0)
  })

multioauth
  .command('multioauth anthropic remove <indexOrEmail>', 'Remove an Anthropic OAuth account from the rotation pool')
  .action(async (indexOrEmail) => {
    const store = await loadAnthropicAccountStore()
    const resolvedIndex = resolveAccountIndex(indexOrEmail, store.accounts)

    if (resolvedIndex < 0) {
      console.error('Usage: kimaki multioauth anthropic remove <index-or-email>')
      process.exit(EXIT_NO_RESTART)
    }

    const removed = store.accounts[resolvedIndex]
    await removeAnthropicAccount(resolvedIndex)
    console.log(
      `Removed Anthropic account ${removed ? anthropicAccountLabel(removed, resolvedIndex) : indexOrEmail}`,
    )
    process.exit(0)
  })

// --- OpenAI subcommands ---

multioauth
  .command('multioauth openai list', 'List stored OpenAI OAuth accounts used for automatic rotation')
  .action(async () => {
    const store = await loadOpenAIAccountStore()
    console.log(`Store: ${openaiAccountsFilePath()}`)
    if (store.accounts.length === 0) {
      console.log('No OpenAI OAuth accounts configured.')
      process.exit(0)
    }

    store.accounts.forEach((account, index) => {
      const active = index === store.activeIndex ? '*' : ' '
      console.log(`${active} ${index + 1}. ${openaiAccountLabel(account)}`)
    })

    process.exit(0)
  })

multioauth
  .command('multioauth openai current', 'Show the current OpenAI OAuth account being used')
  .action(async () => {
    const current = await getCurrentOpenAIAccount()
    console.log(`Store: ${openaiAccountsFilePath()}`)
    console.log(`Auth: ${authFilePath()}`)

    if (!current) {
      console.log('No active OpenAI OAuth account configured.')
      process.exit(0)
    }

    const lines: string[] = []
    lines.push(`Current: ${openaiAccountLabel(current.account || current.auth, current.index)}`)

    if (current.account?.email) {
      lines.push(`Email: ${current.account.email}`)
    } else {
      lines.push('Email: unavailable')
    }

    if (current.account?.accountId) {
      lines.push(`Account ID: ${current.account.accountId}`)
    }

    if (!current.account) {
      lines.push('Rotation pool entry: not found')
    }

    console.log(lines.join('\n'))
    process.exit(0)
  })

multioauth
  .command('multioauth openai remove <indexOrEmail>', 'Remove an OpenAI OAuth account from the rotation pool')
  .action(async (indexOrEmail) => {
    const store = await loadOpenAIAccountStore()
    const resolvedIndex = resolveAccountIndex(indexOrEmail, store.accounts)

    if (resolvedIndex < 0) {
      console.error('Usage: kimaki multioauth openai remove <index-or-email>')
      process.exit(EXIT_NO_RESTART)
    }

    const removed = store.accounts[resolvedIndex]
    await removeOpenAIAccount(resolvedIndex)
    console.log(
      `Removed OpenAI account ${removed ? openaiAccountLabel(removed, resolvedIndex) : indexOrEmail}`,
    )
    process.exit(0)
  })

multioauth
  .command('multioauth openai check', 'Test all OpenAI OAuth accounts for usage limits')
  .action(async () => {
    const store = await loadOpenAIAccountStore()
    if (store.accounts.length === 0) {
      console.log('No OpenAI OAuth accounts configured.')
      process.exit(0)
    }

    console.log('Checking usage limits for all OpenAI accounts...\n')

    for (let i = 0; i < store.accounts.length; i++) {
      const account = store.accounts[i]
      if (!account) continue

      const marker = i === store.activeIndex ? '*' : ' '
      const label = account.email ?? account.accountId ?? 'unknown'
      process.stdout.write(`${marker} ${i + 1}. ${label}: `)

      // Refresh token if expired
      let accessToken = account.access
      if (account.expires < Date.now()) {
        try {
          const response = await fetch('https://auth.openai.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: account.refresh,
              client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
            }).toString(),
          })
          if (!response.ok) {
            console.log('ERROR - Token expired, refresh failed')
            continue
          }
          const json = (await response.json()) as { access_token: string; expires_in?: number }
          accessToken = json.access_token
          account.access = accessToken
          account.expires = Date.now() + (json.expires_in ?? 3600) * 1000
        } catch {
          console.log('ERROR - Token expired, refresh failed')
          continue
        }
      }

      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })

        if (response.ok) {
          console.log('OK')
          continue
        }

        const text = await response.text()
        const isLimited =
          text.includes('usage limit') ||
          text.includes('rate limit') ||
          text.includes('usage_limit') ||
          response.status === 429

        if (isLimited) {
          let resetInfo: string | undefined
          try {
            const json = JSON.parse(text) as { error?: { message?: string } }
            const match = json.error?.message?.match(/try again (after|in) ([^.]+)/i)
            if (match) resetInfo = match[2]
          } catch {}
          console.log(`LIMITED${resetInfo ? ` (resets ${resetInfo})` : ''}`)
        } else if (response.status === 401) {
          console.log('ERROR - Auth failed (token invalid)')
        } else {
          console.log(`ERROR - ${response.status}: ${text.slice(0, 100)}`)
        }
      } catch (err) {
        console.log(`ERROR - ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Save store in case we refreshed any tokens
    await saveOpenAIAccountStore(store)

    process.exit(0)
  })

export default multioauth
