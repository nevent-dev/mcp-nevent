/**
 * HTML Login Page Template for Nevent MCP OAuth Server
 *
 * Renders a minimal, Nevent-branded HTML login form served by the
 * `GET /authorize` endpoint. The form POSTs credentials back to
 * `POST /authorize` where they are validated.
 *
 * Design decisions:
 * - Pure HTML + inline CSS (no external assets → no CDN dependency).
 * - No JavaScript (maximum compatibility, security surface minimized).
 * - The form preserves OAuth flow parameters as hidden fields so the POST
 *   handler can reconstruct the full flow context.
 * - An optional `errorMessage` is displayed when login fails (e.g., wrong
 *   password, unknown user).
 * - An optional `registerMessage` is shown when the user does not exist in
 *   Nevent — directing them to admin.nevent.es to create an account.
 *
 * @module auth/login-page
 */

/** Parameters needed to render the login form. */
export interface LoginPageParams {
  /** OAuth `client_id` — preserved as a hidden form field. */
  clientId: string;
  /** OAuth `redirect_uri` — preserved as a hidden form field. */
  redirectUri: string;
  /** OAuth `response_type` — preserved as a hidden form field. */
  responseType: string;
  /** PKCE `code_challenge` — preserved as a hidden form field. */
  codeChallenge: string;
  /** PKCE `code_challenge_method` — preserved as a hidden form field. */
  codeChallengeMethod: string;
  /** Optional OAuth `scope` — preserved as a hidden form field. */
  scope?: string;
  /** Optional OAuth `state` — preserved as a hidden form field. */
  state?: string;
  /** Optional RFC 8707 `resource` — preserved as a hidden form field. */
  resource?: string;
  /**
   * Optional error message to display (e.g., "Invalid email or password").
   * When set, an error banner is rendered above the form.
   */
  errorMessage?: string;
  /**
   * When `true`, shows a "Register at admin.nevent.es" callout instead of
   * (or alongside) the login form. Set this when the provided email does not
   * correspond to any Nevent user account.
   */
  showRegisterPrompt?: boolean;
}

/**
 * Generates the full HTML string for the Nevent MCP login page.
 *
 * @param params - Render parameters including OAuth flow context and
 *   optional error / registration messages.
 * @returns UTF-8 HTML document as a string.
 *
 * @example
 * ```ts
 * res.setHeader('Content-Type', 'text/html; charset=utf-8');
 * res.send(renderLoginPage({
 *   clientId: req.query.client_id,
 *   redirectUri: req.query.redirect_uri,
 *   ...
 * }));
 * ```
 */
export function renderLoginPage(params: LoginPageParams): string {
  const {
    clientId,
    redirectUri,
    responseType,
    codeChallenge,
    codeChallengeMethod,
    scope = '',
    state = '',
    resource = '',
    errorMessage,
    showRegisterPrompt,
  } = params;

  // Escape HTML entities to prevent XSS through query parameters
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const errorBanner = errorMessage
    ? `
    <div class="alert alert-error">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>${esc(errorMessage)}</span>
    </div>`
    : '';

  const registerCallout = showRegisterPrompt
    ? `
    <div class="alert alert-info">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>
        This email is not registered in Nevent.
        Please <a href="https://admin.nevent.es" target="_blank" rel="noopener noreferrer">create an account at admin.nevent.es</a>
        and try again.
      </span>
    </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nevent — Sign in to authorize access</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
      color: #1a1a1a;
    }

    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.10);
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 400px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-bottom: 2rem;
    }

    .logo svg {
      flex-shrink: 0;
    }

    .logo-text {
      font-size: 1.4rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: #6c3fff;
    }

    h1 {
      font-size: 1.15rem;
      font-weight: 600;
      margin-bottom: 0.3rem;
    }

    .subtitle {
      font-size: 0.875rem;
      color: #666;
      margin-bottom: 1.75rem;
    }

    .alert {
      display: flex;
      gap: 0.6rem;
      align-items: flex-start;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      margin-bottom: 1.25rem;
    }

    .alert svg { flex-shrink: 0; margin-top: 1px; }

    .alert-error {
      background: #fff1f1;
      color: #c0392b;
      border: 1px solid #fca5a5;
    }

    .alert-info {
      background: #f0f4ff;
      color: #2c3e8c;
      border: 1px solid #a3b4f4;
    }

    .alert-info a { color: #4f6ef7; font-weight: 500; }

    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 0.35rem;
      color: #333;
    }

    input[type="email"],
    input[type="password"] {
      display: block;
      width: 100%;
      padding: 0.6rem 0.85rem;
      border: 1.5px solid #ddd;
      border-radius: 8px;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
      margin-bottom: 1rem;
    }

    input:focus { border-color: #6c3fff; }

    .btn {
      display: block;
      width: 100%;
      padding: 0.7rem;
      background: #6c3fff;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .btn:hover { background: #5b2ee8; }
    .btn:active { background: #4a21d1; }

    .footer-note {
      font-size: 0.78rem;
      color: #999;
      text-align: center;
      margin-top: 1.5rem;
    }

    .footer-note a { color: #6c3fff; text-decoration: none; }
    .footer-note a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#6c3fff"/>
        <path d="M8 24V8l8 8 8-8v16" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <span class="logo-text">nevent</span>
    </div>

    <h1>Sign in to your account</h1>
    <p class="subtitle">To authorize access via the Nevent MCP Server</p>

    ${errorBanner}
    ${registerCallout}

    <form method="POST" action="/authorize" autocomplete="on">
      <!-- Preserve OAuth flow context -->
      <input type="hidden" name="client_id"             value="${esc(clientId)}" />
      <input type="hidden" name="redirect_uri"          value="${esc(redirectUri)}" />
      <input type="hidden" name="response_type"         value="${esc(responseType)}" />
      <input type="hidden" name="code_challenge"        value="${esc(codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod)}" />
      ${scope ? `<input type="hidden" name="scope"     value="${esc(scope)}" />` : ''}
      ${state ? `<input type="hidden" name="state"     value="${esc(state)}" />` : ''}
      ${resource ? `<input type="hidden" name="resource" value="${esc(resource)}" />` : ''}

      <label for="email">Email</label>
      <input
        type="email"
        id="email"
        name="email"
        placeholder="you@example.com"
        required
        autocomplete="email"
      />

      <label for="password">Password</label>
      <input
        type="password"
        id="password"
        name="password"
        placeholder="••••••••"
        required
        autocomplete="current-password"
      />

      <button type="submit" class="btn">Sign in</button>
    </form>

    <p class="footer-note">
      Don&apos;t have an account?
      <a href="https://admin.nevent.es" target="_blank" rel="noopener noreferrer">
        Register at admin.nevent.es
      </a>
    </p>
  </div>
</body>
</html>`;
}
