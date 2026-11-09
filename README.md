<p align="center">
  <img src="public/logo.png" alt="gondola" width="240">
</p>

<p align="center">
  <b>Enter a domain. Watch 50 AI designers redesign it at the same time, live.</b><br>
  Every designer works in its own <a href="https://boat.dev">Boat</a> sandbox.
</p>

<p align="center">
  <img src="docs/media/demo.gif" alt="A 10 × 5 grid of 50 finished redesigns of one portfolio, each scrolling through its page" width="100%">
</p>

<p align="center">
  <a href="docs/media/timelapse.mp4">▶ Watch a whole run, from typing the domain to 50 finished sites (40 s)</a>
</p>

## How it works

1. **Read.** One sandbox opens your site and copies every word, image and colour.
2. **Fork.** [Boat](https://boat.dev) forks that sandbox 50 times in about a minute.
3. **Direct.** Each fork gets its own art direction from 76 showpiece styles tagged with the public style
   categories of [Awwwards](https://www.awwwards.com/websites/) and [SiteInspire](https://www.siteinspire.com/)
   (Horizontal Layout, Storytelling, Typographic, Data Visualization…). Every run spreads across as many categories
   as it can, and each style gets a wild palette and a hero idea built from your real content.
4. **Build.** 50 agents design at once. You watch every page appear live in a grid that fits one screen.
5. **Keep.** Finished pages are saved to your own server and the sandboxes are deleted. Copy any design as a
   Claude Code prompt that restyles your whole site in that direction.

## Run it

```sh
git clone https://github.com/forever8896/gondola && cd gondola
bun run setup     # checks Bun, Docker and the Boat CLI, writes .env, starts Postgres
bun run start     # open http://localhost:8787
```

You need [Bun](https://bun.sh), [Docker](https://docs.docker.com/get-docker/), a [Boat](https://boat.dev) account
(`boat login`) and an [OpenRouter](https://openrouter.ai) key with about $10 of credit, **or your own Claude
subscription**: connect it in Boat and Gondola runs every agent as Claude Code
([how](docs/GUIDE.md#two-ways-to-pay-for-the-ai)).

A 25-design run takes about 5 minutes. On your Claude subscription it costs nothing extra; on OpenRouter it's about **$2**
in tokens with Haiku, several times that with Sonnet (the default), plus a few cents of Boat compute. Set
`DEFAULT_COUNT=50` in `.env` for the full wall.

Recording a demo? `bun run prewarm yourdomain.com` reads the site ahead of time, so the next run starts forking
the moment you press enter.

## Built with

- **[Boat](https://boat.dev)**: sandboxes that fork in seconds, live preview URLs and per-second billing
- **Claude Sonnet 5.5** (designs) and **Claude Haiku 5.5** (art direction), either through your own Claude subscription or
  [OpenRouter](https://openrouter.ai) (with DeepSeek V4.1 Flash reading the site and Gemini Flash-Lite describing images)
- **Bun** and **Postgres**, with a vanilla JS frontend and no build step

## Docs

- [Guide](docs/GUIDE.md): requirements, costs and limits, how a run works, configuration, troubleshooting
- [Share pages](docs/GUIDE.md#share-pages): publish a run as a page anyone can open, share and copy prompts from
- [Access control](docs/ACCESS-CONTROL.md): read this before hosting Gondola for other people

## License

[MIT](LICENSE). If Gondola helps you make something, a link back is appreciated.
