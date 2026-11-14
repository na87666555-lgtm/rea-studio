# Rea Studio website browser bridge (experimental)

This optional, single-user service runs an isolated Chromium session for the Rea Studio website-login mode. The user controls the actual pages of ChatGPT, Google Gemini, and Claude from the phone and performs their own sign-ins. It is separate from the existing API mode and does not receive the user's Coarena or other model API keys.

**Status:** the phone-to-browser flow and model handoff have been tested against local fixture sites. The actual public ChatGPT and Gemini websites have returned guest-mode test answers, and all three public login pages opened in a local browser. Authenticated ChatGPT, Gemini, and Claude accounts have not been tested. Provider login restrictions, CAPTCHA, product UI changes, account policies, and answer selectors may prevent the feature working. The bridge reports these failures; it does not bypass a login challenge or substitute another model.

## Privacy and lifetime

- This browser runs on the machine hosting this service, not in the phone's own Chrome. The service operator and hosting platform can potentially access its memory, browser screen, cookies, and credentials typed into it. Host it only in a service you trust; use a dedicated high-entropy token and HTTPS.
- The app sends the screenshots and user interactions through the bridge. Conversation messages, project instructions, and relevant code are sent to the selected official websites. They may be retained according to those services' account settings.
- This implementation has one user/session per service token and closes it after 20 minutes of inactivity. Restart, deploy, or hosting sleep ends that session. The app does not export cookies to disk, but Chromium and the host may use temporary runtime files. You may need to sign in again.
- To keep memory lower, only one provider page is kept open at a time. Switching sites closes the other page, keeps the browser context and cookies, and tries to restore its last conversation. Some sites keep session data per tab or use popups, so this may require signing in again.
- Requests and WebSockets in the browser are restricted to an allowlist of provider, login, and verification domains. This helps reduce unintended access, but can prevent some legitimate provider assets or login methods from loading. The bridge offers no arbitrary URL, shell, or code-execution endpoint.
- API keys and the bridge token must never be committed. The browser bridge token is entered directly in the phone UI, stored only for that browser tab's session, and sent to the configured bridge. Never paste login passwords or tokens into chat messages.

## Running locally

Node.js 20+ and a Playwright Chromium installation are required. Set `REA_BRIDGE_TOKEN` to a unique, random secret at least 32 characters long. Set `REA_APP_ORIGIN` to the **exact** origin of the frontend (for the published app, `https://na87666555-lgtm.github.io`); HTTPS is mandatory except for `http://localhost` or `http://127.0.0.1` development origins. `PORT` defaults to 3000. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` only when using a system Chromium.

```sh
cd browser-bridge
npm ci
npx playwright install chromium
npm test
npm start
```

Expose the service only over HTTPS behind a trusted reverse proxy. CORS is locked to `REA_APP_ORIGIN`, and requests require `Authorization: Bearer <REA_BRIDGE_TOKEN>`. `GET /healthz` is unauthenticated and returns no session data. The process must bind to `0.0.0.0` and use the platform-provided `PORT`.

## Docker deployment

Build from the `browser-bridge/` directory using its `Dockerfile`, set the two environment variables in the host's secret manager, and configure `/healthz` as the health path. The container installs Playwright's Chromium headless shell and runs as a non-root user.

The browser's memory needs exceed Render's 512 MB free and starter web-service plans in local observations: the Chromium headless shell used approximately 622 MiB proportional memory after opening the three provider pages sequentially, and about 701 MiB with Claude alone. The local Docker memory cap was not verifiably enforced; platform accounting, authenticated pages and real workloads may differ. A larger plan may be required and can incur charges. Render's current next web-service size is 1 CPU / 2 GB (`1c-2g`), listed at $25/month as of 14 November 2026. Free Render services also spin down after 15 minutes of inactivity, terminating the session. Choose and approve a plan only after checking current provider pricing and limits.

## Website-mode limitations

The user must open each provider page and complete its login before marking it ready. The confirmation is the user's declaration, not independent verification of login. The bridge checks that it is on the official site's host, sends messages to its visible composer, and only returns a newly created assistant response. If it cannot find the controls or complete a reply, it reports an error.

The workflow uses the browser UI, so the model is whichever model the user selects on the website. Coarena does not choose or replace it. The app sends the prior role's result to the next site, and combines results through a final website turn. A coding role can return a strict JSON envelope of complete file changes; invalid responses cause no automatic file writes. Website mode sends attached text/code files inline (up to 50,000 characters each), and supports shared text project files. Image, PDF, audio, video and other binary attachments cannot yet be sent. Code preview remains the existing local HTML/CSS/JavaScript sandbox.

Run automated checks with `npm test` here and from the repo root run `npm test` and `npm run test:browser`. The frontend integration uses fake provider pages and is not proof of authenticated provider compatibility.
