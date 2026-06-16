import { SlackInstallForm } from './slack-install-form.js'

export function SlackInstallPage({
  clientId,
  clientSecret,
  kimakiCallbackUrl,
}: {
  clientId: string
  clientSecret: string
  kimakiCallbackUrl: string | null
}) {
  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-sm mx-auto px-4">
      <div className="flex flex-col gap-1.5 text-center">
        <h1 className="text-xl font-semibold text-gray-900">
          Connect to Slack
        </h1>
        <p className="text-sm text-gray-500">
          Enter your workspace name to continue
        </p>
      </div>

      <SlackInstallForm
        clientId={clientId}
        clientSecret={clientSecret}
        kimakiCallbackUrl={kimakiCallbackUrl}
      />

      <p className="text-xs text-gray-400 text-center">
        You can find your workspace name in your Slack URL
      </p>
    </div>
  )
}
