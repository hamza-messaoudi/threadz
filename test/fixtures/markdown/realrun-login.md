This assumes the standard OAuth 2.0 Authorization Code flow with PKCE. I haven't seen your codebase, so the endpoint names are generic.

```mermaid
---
title: Login with OAuth (Authorization Code + PKCE)
---
sequenceDiagram
    actor U as User
    participant B as Browser
    participant A as API
    participant P as OAuth Provider

    U->>B: Click "Log in"
    B->>A: GET /auth/login
    A->>A: Generate state + PKCE verifier, store in session
    A-->>B: 302 to provider /authorize (client_id, redirect_uri, state, code_challenge)
    B->>P: GET /authorize
    P->>U: Show login and consent
    U->>P: Authenticate and approve
    P-->>B: 302 to redirect_uri?code=...&state=...
    B->>A: GET /auth/callback?code&state
    A->>A: Verify state matches session
    A->>P: POST /token (code, code_verifier, client_id, client_secret)
    P-->>A: access_token, refresh_token, id_token
    A->>P: GET /userinfo (Bearer access_token)
    P-->>A: User profile
    A->>A: Create or link user, create session
    A-->>B: 302 to app, Set-Cookie session (HttpOnly, Secure)
    B->>A: Authenticated requests with cookie
```

- **Token exchange:** it is the `POST /token` step. It runs server to server, so the provider's tokens never reach the browser.
- **`state`:** the API checks it at the callback to prevent CSRF.
- **PKCE:** `code_verifier` ties the code to the session that started the flow. This protects against code interception.
- **Session cookie:** the browser only ever holds this cookie.

If you use a SPA that calls the provider directly, or return your own JWT instead of a cookie, tell me and I'll adjust the diagram.
