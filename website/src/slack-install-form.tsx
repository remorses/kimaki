'use client'

import { useState } from 'react'

export function SlackInstallForm({
  clientId,
  clientSecret,
  kimakiCallbackUrl,
}: {
  clientId: string
  clientSecret: string
  kimakiCallbackUrl: string | null
}) {
  const [domain, setDomain] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = domain.trim().toLowerCase()
    if (!trimmed) {
      setError('Please enter a workspace name')
      return
    }

    setError('')
    setLoading(true)

    try {
      const res = await fetch(
        `/slack-install/resolve?domain=${encodeURIComponent(trimmed)}`,
      )
      const data = (await res.json()) as {
        ok: boolean
        teamId?: string
        teamName?: string
        error?: string
      }

      if (!data.ok) {
        setError(data.error || 'Workspace not found')
        setLoading(false)
        return
      }

      // Build the redirect URL with the resolved team ID
      const params = new URLSearchParams()
      params.set('clientId', clientId)
      params.set('clientSecret', clientSecret)
      params.set('team', data.teamId || '')
      if (kimakiCallbackUrl) {
        params.set('kimakiCallbackUrl', kimakiCallbackUrl)
      }

      window.location.href = `/slack-install/start?${params.toString()}`
    } catch {
      setError('Failed to resolve workspace. Please try again.')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 w-full">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="slack-domain"
          className="text-sm font-medium text-gray-700"
        >
          Workspace name
        </label>
        <div className="flex items-center rounded-lg border border-gray-300 bg-white focus-within:border-black focus-within:ring-1 focus-within:ring-black transition-colors">
          <input
            id="slack-domain"
            type="text"
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value)
              if (error) {
                setError('')
              }
            }}
            placeholder="your-workspace"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={loading}
            className="grow px-3 py-2.5 text-sm bg-transparent outline-none placeholder:text-gray-400 disabled:opacity-50"
          />
          <span className="pr-3 text-sm text-gray-400 select-none">
            .slack.com
          </span>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-black px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg
              className="animate-spin size-4"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Resolving...
          </span>
        ) : (
          'Continue'
        )}
      </button>
    </form>
  )
}
