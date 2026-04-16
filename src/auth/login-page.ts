/**
 * HTML Login Page Template for Nevent MCP OAuth Server
 *
 * Renders the Nevent Single Sign-On login form served by the
 * `GET /authorize` endpoint. The form POSTs credentials back to
 * `POST /authorize` where they are validated.
 *
 * Design decisions:
 * - Pure HTML + inline CSS (no external assets except Google Fonts CDN).
 * - No JavaScript (maximum compatibility, minimal security surface).
 * - The form preserves OAuth flow parameters as hidden fields so the POST
 *   handler can reconstruct the full flow context.
 * - An optional `errorMessage` is displayed when login fails (e.g., wrong
 *   password, unknown user).
 * - An optional `registerMessage` is shown when the user does not exist in
 *   Nevent — directing them to admin.nevent.es to create an account.
 * - Branded to match admin.nevent.es visual identity:
 *   - Primary: #2c1dd0, Secondary: #975cf8
 *   - Gradient: linear-gradient(45deg, #2c1dd0, #975cf8)
 *   - Font: Poppins
 * - When `clientName` is provided, the header shows both the Nevent wordmark
 *   and the client icon with a connector between them.
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
  /**
   * Optional human-readable name of the OAuth client (e.g. "Claude", "ChatGPT").
   * When provided, the page header shows "Connect Nevent with {clientName}"
   * along with both the Nevent wordmark and a client-specific icon.
   * When omitted, the page defaults to "Single Sign-On".
   */
  clientName?: string;
}

// ---------------------------------------------------------------------------
// Client icon helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the background colour for a client icon based on the client name.
 *
 * Known mappings:
 * - "claude"            → Anthropic orange (#D97757)
 * - "chatgpt"/"openai"  → OpenAI green (#10A37F)
 * - "gemini"/"google"   → Google blue (#4285F4)
 * - "cursor"            → Black (#000000)
 * - unknown             → Neutral gray (#6B7280)
 *
 * @param nameLower - Lowercase client name.
 * @returns Hex colour string.
 */
function clientIconColor(nameLower: string): string {
  if (nameLower.includes('claude')) return '#D97757';
  if (nameLower.includes('chatgpt') || nameLower.includes('openai')) return '#10A37F';
  if (nameLower.includes('gemini') || nameLower.includes('google')) return '#4285F4';
  if (nameLower.includes('cursor')) return '#000000';
  return '#6B7280';
}

/**
 * Returns the logo URL for a known OAuth client, or null for unknown clients.
 */
function clientLogoUrl(nameLower: string): string | null {
  if (nameLower.includes('claude')) return 'https://avatars.slack-edge.com/2025-05-14/8891273522918_30c38bf627ac73075db6_512.png';
  if (nameLower.includes('chatgpt') || nameLower.includes('openai')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/ChatGPT_logo.svg/3840px-ChatGPT_logo.svg.png';
  return null;
}

/**
 * Renders a small rounded-square icon for the OAuth client.
 *
 * Uses the official logo for known clients (Claude, ChatGPT).
 * Falls back to the first character on a coloured background for unknown clients.
 *
 * @param clientName - Human-readable client name, already XSS-escaped.
 * @returns HTML string for the client icon element.
 */
function renderClientIcon(clientName: string): string {
  const nameLower = clientName.toLowerCase();
  const logoUrl = clientLogoUrl(nameLower);

  if (logoUrl) {
    return `<div class="client-icon" style="background:#fff; padding:6px;"><img src="${logoUrl}" alt="${clientName}" style="width:100%; height:100%; object-fit:contain; border-radius:4px;" /></div>`;
  }

  const color = clientIconColor(nameLower);
  const letter = clientName.charAt(0).toUpperCase();
  return `<div class="client-icon" style="background:${color};">${letter}</div>`;
}

/**
 * Generates the full HTML string for the Nevent MCP login page.
 *
 * The page is branded to match admin.nevent.es. When `clientName` is
 * supplied, the header shows both the Nevent wordmark and a client icon
 * connected by a dotted line, with the title "Connect Nevent with
 * {clientName}". Without a client name the title defaults to
 * "Single Sign-On".
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
 *   clientName: client.client_name,
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
    clientName,
  } = params;

  // Escape HTML entities to prevent XSS through query parameters
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---- Title logic --------------------------------------------------------
  // Use client name when available, fall back to generic "Single Sign-On"
  const escapedClientName = clientName ? esc(clientName) : '';
  const pageTitle = escapedClientName
    ? `Connect Nevent with ${escapedClientName}`
    : 'Single Sign-On';

  // ---- Header section (logos + connector) ---------------------------------
  const logoSection = escapedClientName
    ? `
    <div class="logo-header">
      <div class="logo-nevent">
        <img
          src="https://admin.nevent.es/assets/images/nevent-logo-black.webp"
          alt="Nevent"
          class="nevent-wordmark"
        />
      </div>
      <div class="connector" aria-hidden="true">
        <div class="connector-dot"></div>
        <div class="connector-line"></div>
        <div class="connector-dot"></div>
      </div>
      ${renderClientIcon(escapedClientName)}
    </div>`
    : `
    <div class="logo-header logo-header--centered">
      <img
        src="https://admin.nevent.es/assets/images/nevent-logo-black.webp"
        alt="Nevent"
        class="nevent-wordmark"
      />
    </div>`;

  // ---- Alert banners ------------------------------------------------------
  const errorBanner = errorMessage
    ? `
    <div class="alert alert-error">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
  <title>Nevent — ${pageTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f4f4f7;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.25rem;
      color: #1a1a2e;
    }

    .card {
      background: #ffffff;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      padding: 2.5rem 2.25rem;
      width: 100%;
      max-width: 420px;
    }

    /* -----------------------------------------------------------------------
       Logo header — Nevent wordmark [connector] Client icon
    ----------------------------------------------------------------------- */
    .logo-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      margin-bottom: 1.75rem;
    }

    .logo-header--centered {
      justify-content: center;
    }

    .logo-nevent {
      display: flex;
      align-items: center;
    }

    .nevent-wordmark {
      max-width: 120px;
      height: auto;
      display: block;
    }

    /* Connector: dot — line — dot */
    .connector {
      display: flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }

    .connector-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #d1d5db;
      flex-shrink: 0;
    }

    .connector-line {
      width: 24px;
      height: 2px;
      background: repeating-linear-gradient(
        to right,
        #d1d5db 0px,
        #d1d5db 4px,
        transparent 4px,
        transparent 8px
      );
      flex-shrink: 0;
    }

    /* Client icon: rounded square with first letter */
    .client-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.125rem;
      font-weight: 700;
      color: #ffffff;
      flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    /* -----------------------------------------------------------------------
       Heading + subtitle
    ----------------------------------------------------------------------- */
    .heading {
      text-align: center;
      margin-bottom: 1.75rem;
    }

    .heading h1 {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(45deg, #2c1dd0, #975cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.35rem;
      line-height: 1.3;
    }

    .heading .subtitle {
      font-size: 0.875rem;
      color: #6b7280;
      font-weight: 400;
    }

    /* -----------------------------------------------------------------------
       Alert banners
    ----------------------------------------------------------------------- */
    .alert {
      display: flex;
      gap: 0.6rem;
      align-items: flex-start;
      padding: 0.8rem 1rem;
      border-radius: 8px;
      font-size: 0.8125rem;
      line-height: 1.5;
      margin-bottom: 1.25rem;
    }

    .alert svg {
      flex-shrink: 0;
      margin-top: 2px;
    }

    .alert-error {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fca5a5;
    }

    .alert-info {
      background: #eff6ff;
      color: #1d4ed8;
      border: 1px solid #93c5fd;
    }

    .alert-info a {
      color: #2c1dd0;
      font-weight: 600;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .alert-info a:hover {
      color: #975cf8;
    }

    /* -----------------------------------------------------------------------
       Form fields
    ----------------------------------------------------------------------- */
    .field {
      margin-bottom: 1.1rem;
    }

    label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      color: #374151;
      margin-bottom: 0.4rem;
    }

    .input-wrap {
      position: relative;
    }

    .input-icon {
      position: absolute;
      top: 50%;
      left: 0.85rem;
      transform: translateY(-50%);
      color: #9ca3af;
      pointer-events: none;
      display: flex;
      align-items: center;
    }

    input[type="email"],
    input[type="password"] {
      display: block;
      width: 100%;
      padding: 0.65rem 0.85rem 0.65rem 2.5rem;
      border: 1.5px solid #d1d5db;
      border-radius: 8px;
      font-family: inherit;
      font-size: 0.9375rem;
      color: #111827;
      background: #ffffff;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    input[type="email"]:focus,
    input[type="password"]:focus {
      border-color: #2c1dd0;
      box-shadow: 0 0 0 3px rgba(44, 29, 208, 0.12);
    }

    input::placeholder {
      color: #9ca3af;
    }

    /* -----------------------------------------------------------------------
       Submit button
    ----------------------------------------------------------------------- */
    .btn {
      display: block;
      width: 100%;
      padding: 0.75rem;
      background: linear-gradient(45deg, #2c1dd0, #975cf8);
      color: #ffffff;
      font-family: inherit;
      font-size: 0.9375rem;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      letter-spacing: 0.01em;
      transition: opacity 0.15s, transform 0.1s;
      margin-top: 0.5rem;
    }

    .btn:hover {
      opacity: 0.92;
    }

    .btn:active {
      opacity: 0.85;
      transform: scale(0.99);
    }

    /* -----------------------------------------------------------------------
       Footer
    ----------------------------------------------------------------------- */
    .footer-note {
      font-size: 0.78rem;
      color: #9ca3af;
      text-align: center;
      margin-top: 1.5rem;
    }

    .footer-note a {
      color: #2c1dd0;
      font-weight: 500;
      text-decoration: none;
    }

    .footer-note a:hover {
      text-decoration: underline;
      color: #975cf8;
    }
  </style>
</head>
<body>
  <div class="card">

    <!-- Logo header: Nevent wordmark + connector + client icon (or wordmark only) -->
    ${logoSection}

    <!-- Title -->
    <div class="heading">
      <h1>${pageTitle}</h1>
      <p class="subtitle">Sign in with your Nevent account</p>
    </div>

    ${errorBanner}
    ${registerCallout}

    <form method="POST" action="/authorize" autocomplete="on">
      <!-- Preserve OAuth flow context as hidden fields -->
      <input type="hidden" name="client_id"             value="${esc(clientId)}" />
      <input type="hidden" name="redirect_uri"          value="${esc(redirectUri)}" />
      <input type="hidden" name="response_type"         value="${esc(responseType)}" />
      <input type="hidden" name="code_challenge"        value="${esc(codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod)}" />
      ${scope    ? `<input type="hidden" name="scope"    value="${esc(scope)}" />`    : ''}
      ${state    ? `<input type="hidden" name="state"    value="${esc(state)}" />`    : ''}
      ${resource ? `<input type="hidden" name="resource" value="${esc(resource)}" />` : ''}

      <!-- Email field -->
      <div class="field">
        <label for="email">Email address</label>
        <div class="input-wrap">
          <span class="input-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
          </span>
          <input
            type="email"
            id="email"
            name="email"
            placeholder="you@company.com"
            required
            autocomplete="email"
          />
        </div>
      </div>

      <!-- Password field -->
      <div class="field">
        <label for="password">Password</label>
        <div class="input-wrap">
          <span class="input-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </span>
          <input
            type="password"
            id="password"
            name="password"
            placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
            required
            autocomplete="current-password"
          />
        </div>
      </div>

      <button type="submit" class="btn">Sign in</button>
    </form>

    <p class="footer-note">
      Don&apos;t have an account?
      <a href="https://admin.nevent.es" target="_blank" rel="noopener noreferrer">Register at admin.nevent.es</a>
    </p>

  </div>
</body>
</html>`;
}
