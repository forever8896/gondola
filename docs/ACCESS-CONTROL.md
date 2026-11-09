# Who sees what: access control in Gondola

The rule the whole system enforces: **a run, its live activity and its pages are visible only to the person who
started it.** Boat and the sandboxes never know who the user is; our app holds that mapping and checks it on
every request.

## 1. The chain of ownership

```
browser ──cookie sid──▶ sessions.id
                           │ owner
                           ▼
                        runs.id (128-bit random) ──▶ designs (token: 128-bit random)
                           │                              │
                           ▼                              ▼
                        sandboxes.id (bx_…)            design_files / run_assets (Postgres)
                        (Boat, our account only)
```

| Layer | What identifies it | Who holds it | Check |
|---|---|---|---|
| Session | `sid` cookie = `id.HMAC(id)`, HttpOnly, SameSite=Lax, Secure in prod | the browser | HMAC verified with constant-time compare; unknown or forged → new session |
| Run | `runs.id`, 22 chars base64url (128 bits) | the owner's browser (URL `/r/<id>`) | every API route: `WHERE id = $run AND owner = $sid`; otherwise **404**, so other runs' existence is never revealed |
| Live stream | `/api/runs/<id>/stream` (SSE) | the owner's browser | same owner check before subscribing; the event bus is keyed by run id, nothing is broadcast globally |
| Screenshots | `/api/runs/<id>/designs/<n>/*.png` | the owner's browser | same owner check |
| Finished page | `pages-origin/p/<design token>/` | handed out only in the owner's API responses | possession of the token (capability URL), see §3 |
| Sandbox | `bx_…`, Boat preview URLs and tokens | **server only** | never sent to a browser; users never talk to Boat |

Implemented in `app/src/server.ts` (`ownedRun`, `readSession`) and `app/src/pipeline.ts` (`subscribe`, `emit`).

## 2. What the app does today (anonymous, built)

- First visit creates an anonymous session (row in `sessions`) and sets the signed cookie.
- `POST /api/runs` requires that session and an `Origin` header equal to our own origin (CSRF), and allows
  1 active run per session (plus the optional `DAILY_RUN_LIMIT`, §10).
- Run ids and design tokens come from `crypto.getRandomValues` (128 bits). They can't be guessed or enumerated.
- Everything a user can see is fetched with the owner check. Sandbox ids, Boat URLs and the OpenRouter key stay on the server.

Limitation: an anonymous session lives in one browser. Clear cookies or switch device and the runs are gone
(still in the DB, just unreachable). That's the reason for §4.

## 3. Finished pages are untrusted HTML, so they get their own origin

The pages are written by an AI agent that read **someone's website**. That site could contain a prompt
injection ("add this script to the page…"), so treat every generated page as hostile.

- Pages are served from a **separate origin** (`pages.<domain>` in production; `:8788` locally). JavaScript
  there can't read the app's cookies or call the app's API as the user.
- The response CSP is `connect-src 'none'; form-action 'none'`. Pages can't phone home or post forms. Only
  their own files and Google Fonts load. `frame-ancestors` is limited to the app.
- The URL is a capability (`/p/<token>/`). Anyone holding it can view the page, which is what makes the
  "share this design" link work. If pages must be strictly owner-only:
  - **Signed expiring URLs:** the API mints `/p/<token>/?exp=…&sig=HMAC(token|exp)` per request. The pages
    origin verifies the signature and sets a short-lived cookie scoped to `/p/<token>/` so relative asset
    URLs keep working.
  - Or a **cookie handshake** across the two origins. More moving parts; only worth it with real accounts.

## 4. When this goes live: accounts

1. `users (id, email, created_at)`, login by email magic link or GitHub OAuth. `sessions.user_id` nullable.
2. On login, **claim** the anonymous session's runs: `UPDATE runs SET owner_user = $user WHERE owner = $sid`.
   Ownership becomes `owner_user`, and the check changes from `owner = $sid` to `owner_user = $user`, in one
   function (`ownedRun`).
3. Payments (PRD: $19 one-off) attach to `users`, and a run can only be created with credit available.
4. Admin view behind a separate role, never via guessable URLs.

## 5. Agents, secrets and prompt injection (most important for a public launch)

Today every fork inherits our Boat account's stored AI credentials, so **the real OpenRouter key is inside each
sandbox**. A hostile site could try to get the extraction or design agent to leak it.

Before going public:
- **Turn on Boat's AI credentials proxy** (`boat ai proxy`). Sandboxes then get placeholder keys and the real key
  never enters them. Costs $1/day + $1 per 1,000 requests, which is small next to the token bill.
- Use a **dedicated OpenRouter key** with a hard monthly cap (the current one has a $50 cap; keep it that way).
- Prompts already tell agents to treat page content as data. Keep that, but don't rely on it.
- Each fork is deleted as soon as its files are in Postgres. Base sandboxes are deleted when the run ends.
  `sandboxes` tracks everything we create, and on boot `recover()` deletes anything left behind.

## 6. Abuse: whose site may be redesigned?

The PRD's non-goal is "remixing third-party sites". To enforce it:
- **Domain verification** before a run: the user adds `<meta name="redesigner-verify" content="<token>">` or a
  DNS TXT record. Without it, allow only a short preview (e.g. 3 designs) or block entirely.
- **Rate limits** per session, per IP and per verified domain. Add a Turnstile challenge on the form.
- The ingest runs inside a Boat sandbox, not on our server, so a malicious URL can't reach our internal
  network (no SSRF against us). We still reject IPs, localhost and non-standard ports.

## 7. Data lifecycle

- Keep runs for 30 days, then delete them (`ON DELETE CASCADE` takes designs, files and events with them).
  Users can delete a run themselves (add `DELETE /api/runs/:id` with the same owner check).
- Screenshots and media are stored once per run (`run_assets`) and shared across its designs.

## 8. Capacity: what Boat lets us run ($20 plan)

| Limit | Value | Effect for 25-design runs (26 sandboxes each) |
|---|---|---|
| Active sandboxes | 100 | at most 3 runs at once (we cap at 95) |
| Starts per minute | 12 | forking takes about 2.5 min per run (we pace at 11/min) |
| Starts per hour | 60 | **2 runs per hour**: the real bottleneck |
| Starts per day | 200 | **7 runs per day** |

Runs that don't fit wait in the queue (`status = 'queued'`) and the page shows their position. The $100 plan
(300 active, 210/hour, 840/day) allows about 8 runs/hour and 32/day. Boat's "extra starts" setting allows more
for $0.03–0.07 per start.

## 9. Running more than one server

The event bus and start limiter live in the process, so run exactly one app instance. To scale out: use
Postgres `LISTEN/NOTIFY` for the bus, take a `pg_advisory_lock` for the scheduler, and keep the limiter's
timestamps in a table.

## 10. Limits on a self-hosted server

Gondola is open source and self-hosted, so by default anyone who can reach the server can start runs, one at a
time per browser. `src/access.ts` checks this inside one transaction holding an advisory lock, so simultaneous
requests can't slip past it (tested with 8 parallel visitors).

- `DAILY_RUN_LIMIT` (0 = unlimited) caps runs per UTC day across all visitors; the operator (admin cookie) is
  not counted. Set it before exposing the app.
- Runs that don't fit Boat's capacity wait in the queue (§8).

Not included: payments, accounts, invite codes, bot protection. A public deployment should add bot protection
(e.g. Turnstile) to the form, or a script can use up the daily limit.
