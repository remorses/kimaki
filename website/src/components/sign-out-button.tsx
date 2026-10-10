// Client component that performs a native form POST to /dashboard/sign-out.
// React RSC intercepts forms with string `action` props, so we need a ref-based
// native submit to bypass RSC's form handling.
'use client'

import { useRef } from 'react'

export function SignOutButton() {
  const formRef = useRef<HTMLFormElement>(null)
  return (
    <form
      ref={formRef}
      action="/dashboard/sign-out"
      method="POST"
      onSubmit={(e) => {
        e.preventDefault()
        formRef.current?.submit()
      }}
    >
      <button
        type="submit"
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        Sign out
      </button>
    </form>
  )
}
