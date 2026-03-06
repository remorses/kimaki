// Plain HTML template for the OAuth success page.
// Replaces the React component to avoid bundling react + react-dom (~551 KiB)
// in the Cloudflare Worker. This page is trivial static HTML.

export function renderSuccessPage({ guildId }: { guildId?: string } = {}): string {
  const guildSection = guildId
    ? `<p style="margin-top: 16px">Guild: <span class="guild-id">${escapeHtml(guildId)}</span></p>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kimaki - Bot Installed</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      text-align: center;
      padding: 48px;
      max-width: 480px;
    }
    .checkmark {
      font-size: 64px;
      margin-bottom: 24px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 12px;
      color: #fff;
    }
    p {
      font-size: 16px;
      line-height: 1.5;
      color: #a0a0b0;
    }
    .guild-id {
      font-family: monospace;
      background: #2a2a3e;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">&#10003;</div>
    <h1>Kimaki bot installed successfully</h1>
    <p>You can close this tab and return to your terminal.</p>
    ${guildSection}
  </div>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
