# Gondola guide

Everything the README leaves out: requirements, costs and limits, how a run works, configuration and
troubleshooting.

## What you need

| | |
|---|---|
| [Bun](https://bun.sh) 1.3+ | runs the server (no npm dependencies) |
| [Docker](https://docs.docker.com/get-docker/) | runs Postgres locally |
| A [Boat](https://boat.dev) account and the `boat` CLI, signed in (`boat login`) | the sandboxes. A run needs designs + 1 sandboxes at once; Boat's $20 plan allows 100 |
| An [OpenRouter](https://openrouter.ai) key with **at least $10 of credit**, *or* your own Claude subscription ([see below](#two-ways-to-pay-for-the-ai)) | the models. With OpenRouter, parallel agents reserve credit up front, so a thin balance makes designs fail mid-run |

`bun run setup` checks all of this, writes `.env` with fresh secrets and starts Postgres. `bun run doctor`
re-checks at any time, including your Boat plan limits and your OpenRouter balance.

The agents run inside Boat sandboxes and get their model key from your Boat AI profile. `setup` offers to store
it there; otherwise run `boat ai profile set-key default openrouter-api-key`.

## Two ways to pay for the AI

| | OpenRouter (default) | Your Claude subscription |
|---|---|---|
| Setting | `AI_BACKEND=openrouter` | `AI_BACKEND=subscription` |
| Design and reading agents (in the sandboxes) | any OpenRouter model through Boat's `pi`/`opencode` harness, on the OpenRouter key in your Boat AI profile | Claude Code through Boat's `claude` harness, on the Claude account connected to your Boat AI profile |
| Curator and image descriptions (on your machine) | OpenRouter API (`OPENROUTER_API_KEY`) | your local Claude Code CLI (`claude -p`) |
| Cost | ~$2 per 25 designs in tokens | included in your subscription, within its usage limits |

**Using your subscription:**
1. Connect your Claude account to your **default** profile in the Boat dashboard (`boat dashboard` → AI credentials).
2. Install [Claude Code](https://docs.anthropic.com/claude-code) on the machine running Gondola and sign in (`claude`).
3. In `.env`: `AI_BACKEND=subscription`, `MODEL=claude-haiku-5-5`, `EXTRACT_MODEL=claude-haiku-5-5`, and optionally
   `AGENT_REASONING=low` for quicker agent steps.
4. `bun run doctor` checks both: the Claude account in Boat and the local CLI.

Subscriptions have usage limits, and a run starts many Claude Code sessions at once, so smaller runs (10–25
designs) are more reliable than 50. Use it with your own account for your own sites; follow Anthropic's terms for
your plan. A Gondola hosted for other people should use API keys.

**Subscription mode:** your Boat AI profile must hold only the Claude sign-in. If it also has an OpenRouter key, Boat bills the sandbox agents to OpenRouter instead (`bun run doctor` checks this; remove it with `boat ai profile rm-key default openrouter-api-key`).

## Where the design directions come from

Every direction is a hand-written brief in [`kit/briefs.json`](../kit/briefs.json): a style family, a reference
it is *in the spirit of* (a design movement, a designer, a publication or a product, never a site to copy), a
palette, type, layout, motion, density and one hard rule that pushes it away from the safe default.

Each showpiece brief is tagged with the **public style categories of award directories** it embodies: Awwwards
tags (Typography, Horizontal Layout, Storytelling, Data Visualization, Unusual Navigation, Parallax, Filters and
Effects, …) and SiteInspire categories (Typographic, Grid Layout, Unusual Layout, Minimal). The taxonomy, its
sources and the date it was read are in [`kit/directory-tags.json`](../kit/directory-tags.json). Only the
category names are used; nothing from the listed sites themselves.

For each run, the curator picks briefs with no style family twice and **as many different directory categories
as possible** (a 50-design run typically covers 30+ of the 37), then writes each pick a wild palette and a hero
idea from the site's real content.

## Costs and limits

Measured on real runs with the default models:

| | 25 designs | 50 designs |
|---|---|---|
| Model tokens (OpenRouter) | ~$1.50–2.50 | ~$3.50–5 |
| Boat compute (small sandboxes, each deleted once its design is saved) | ~$0.05 | ~$0.10 |
| Time | ~5–7 min | ~6–8 min |

Boat counts every sandbox start (on the $20 plan: 12 per minute, 60 per hour, 200 per day). Gondola paces starts
to stay inside the `STARTS_PER_*` values in `.env` and queues runs that don't fit. Boat's "extra starts" option
raises the limits for a small per-start fee; raise `STARTS_PER_*` to match.

## How a run works

1. **Read.** A base sandbox opens the site in headless Chrome. An agent copies every word into `content.md`; the
   images are downloaded and described by a vision model (size, aspect ratio, text printed in them); the current
   look is measured (colours, fonts, layout) so the designs can steer away from it.
2. **Fork.** The base is snapshotted and forked once per design, so every designer starts with the site in place.
3. **Curate.** While the forks start, a curator model picks that many of the showpiece directions (see
   [above](#where-the-design-directions-come-from)), no two from the same family and spread across as many
   award-directory categories as possible, and writes each one a wild palette and a hero idea from the site's facts.
4. **Build.** Each agent follows `kit/AGENTS.template.md` (facts verbatim, the brief, image rules, an award-level
   bar), then gets an elevate pass. A browser check inside the sandbox (`kit/qa.mjs`) catches crops, contrast,
   unstyled pages and mobile problems for one round of fixes.
5. **Keep.** Screenshots and files go into Postgres and the sandbox is deleted. Finished pages are served from a
   second origin, so agent-written HTML can never touch the app.

While a design is being built, its grid cell shows the sandbox's page live through a proxy on that second origin.
When it's done, the cell scrolls through a full-page screenshot.

### Instant starts: prewarm

`bun run prewarm example.com` does step 1 once and keeps the snapshotted base for `WARM_TTL_HOURS` (24). Runs of
that site in that window skip reading and start forking within seconds, which is handy before a screen recording.
The sweeper removes the prepared copy when it expires.

## Using it

- **The grid** fits the whole run on one screen (5 × 5 for 25, 10 × 5 for 50). Hover a cell for its name; click it
  for the large scroll view; the grid button returns.
- **Copy prompt** on a finished design gives you a Claude Code prompt that restyles your whole site (every page,
  not just the homepage) in that direction, keeping your content as is.
- **Your runs** are tied to your browser. Open `/admin?token=<ADMIN_TOKEN>` once (token in `.env`) to see every
  run on the server.

## Share pages

Publish a finished run as a page anyone can open: the same grid and scroll view, every design as its own standalone
page, Copy prompt on each one, Share on X / Copy link buttons, and a link preview made from that run's designs.
Shares are static files served by Cloudflare (a static-assets Worker, the successor to Cloudflare Pages; free), so
nothing of yours has to stay online.

One-time setup: `bunx wrangler login`, then set `SHARE_ORIGIN` in `.env` to the address you want (e.g.
`https://gondola.example.com`, on a domain in the same Cloudflare account). The first `bun run share` creates the
Worker and attaches the domain; the domain must not already have a DNS record of its own (delete an old one first).
`SHARE_PROJECT` names the Worker (default `gondola`).

```sh
bun run share example.com           # publish the latest finished run for example.com, prints the link
bun run share example.com --skip 3  # leave a design out
bun run share list                  # what's published
bun run share remove <slug>         # take one down
bun run share deploy                # redeploy (e.g. after changing the landing page in site/)
```

Each share lives at `/s/<site>-<random>/`: unlisted (the address can't be guessed, and search engines are told not
to index it), at the same address when you republish the run. A design's own page is `/s/<slug>/p/<n>/`. The deploy
also carries the landing page from `site/`. Cloudflare allows 20,000 files per site, about 60 shares of 50
designs; `bun run share` warns before that. Design pages get the same restrictive content policy as in the app.

## Configuration

Everything lives in `.env`; [`.env.example`](../.env.example) documents each setting. The usual ones:

| Setting | What it does |
|---|---|
| `DEFAULT_COUNT` / `MAX_COUNT` | designs per run (25 or 50 fill the grid nicely) |
| `MODEL` | the design model. Any `openrouter:` model works with Boat's `pi` harness; Anthropic models go through `opencode` automatically |
| `EXTRACT_MODEL`, `CURATOR_MODEL`, `VISION_MODEL` | reading the site, choosing directions, describing images |
| `STARTS_PER_MINUTE` / `_HOUR` / `_DAY`, `MAX_ACTIVE_SANDBOXES` | keep within `boat limits` |
| `DAILY_RUN_LIMIT` | cap runs per day if other people can reach your server |
| `INCLUDE_CALM_BRIEFS` | also allow the quiet directions (pure type, docs, e-reader…) |

## Code map

| Path | What it is |
|---|---|
| `src/server.ts` | HTTP: sessions, run API, live stream (SSE), the pages origin, the live-preview proxy |
| `src/pipeline.ts` | the worker: queue, read, prewarm, curator, fork, agent turns, QA, capture, cleanup sweeper |
| `src/access.ts` | who may start a run (one at a time per browser, optional daily cap) |
| `src/boat.ts` | `boat` CLI wrapper and start-rate limiter |
| `kit/` | the agents' rules, 92 design briefs and their directory tags, the asset fetcher and the browser checks that run in sandboxes |
| `public/` | the frontend (vanilla JS, no build step) |
| `scripts/` | `setup`, `doctor`, `prewarm`, `share` (static share pages) |
| `src/prompt.ts`, `src/embed.ts` | the Copy prompt text, and the auto-scroll helper injected into embedded pages |
| `schema.sql` | the database, applied on every start |

## Troubleshooting

- **Cells say "Didn't make it".** Run `bun run doctor`. The usual cause is a low OpenRouter balance: many agents
  reserve credit at once, and requests are refused when the reservations exceed what's left.
- **A run waits in the queue.** It needs designs + 1 free sandboxes and enough start budget for the hour.
- **Sandboxes left running.** Each sandbox is deleted as soon as its design is saved, and a sweeper checks Boat
  every 10 minutes for strays (named `gondola-…`, not part of a run in progress or a prepared site). `boat list`
  shows what's running.

## Hosting it for other people

Read [ACCESS-CONTROL.md](ACCESS-CONTROL.md). In short:
- serve the app and the pages from two subdomains;
- set `DAILY_RUN_LIMIT`;
- turn on Boat's AI credentials proxy (`boat ai proxy on`), so the real model key never sits in a sandbox that
  reads a stranger's website;
- add bot protection to the form.
