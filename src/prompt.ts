// The "Copy prompt" text: tells Claude Code to redo a whole site in the style of one design.
/**
 * The Claude Code prompt for one design. `base` is where the design's files can be downloaded (ends with /);
 * images live under `${base}assets/`.
 */
export function claudePrompt(run: any, d: any, files: string[], base: string) {
  const b = d.brief ?? {};
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : null);
  const lines = [
    `Redesign my ENTIRE website in the style of the reference design below.`,
    ``,
    `My site: ${run.url}`,
    `Reference design: "${d.name ?? b.style_family}". It is a redesign of my HOMEPAGE ONLY: ${base}`,
    d.summary ? `What it is: ${d.summary}` : null,
    ``,
    `## Reference files`,
    `Download these with curl, not WebFetch: you need the exact markup and CSS, not a summary.`,
    ...files.map(f => `  curl -sL ${base}${f}`),
    `Images it uses are under ${base}assets/... and are the same images my site already has.`,
    ``,
    `## The direction it was built from`,
    b.style_family ? `- Style family: ${b.style_family}` : null,
    b.reference ? `- In the spirit of: ${b.reference}` : null,
    b.palette ? `- Palette: ${b.palette}` : null,
    list(d.palette) ? `- Palette as built: ${list(d.palette)}` : null,
    b.typography ? `- Typography: ${b.typography}` : null,
    list(d.fonts) ? `- Fonts as built: ${list(d.fonts)}` : null,
    b.layout ? `- Layout: ${b.layout}` : null,
    b.motion ? `- Motion: ${b.motion}` : null,
    b.density ? `- Density: ${b.density}` : null,
    b.hard_constraint ? `- Signature rule: ${b.hard_constraint}` : null,
    ``,
    `## What to do`,
    `1. Fetch the reference files and study them. Write a short design system to DESIGN.md: colour tokens, type scale and`,
    `   fonts, spacing, the components it uses (nav, buttons, cards or lists, section headers, media frames, footer),`,
    `   motion rules, and the 3-5 signature moves that make this style recognisable.`,
    `2. The reference covers only the homepage. Apply the design system to EVERY page of my site: find all routes in this`,
    `   codebase (homepage, subpages, project/case-study pages, blog index and posts, contact, 404, any templates) and redesign`,
    `   each one. Pages the reference doesn't show should look like they were designed by the same hand, not left in the old style.`,
    `3. Content stays exactly as it is in my codebase: every word, link, image, alt text, metadata and SEO tag. The reference's`,
    `   text was copied from my homepage, but my code is the source of truth. Do not invent content.`,
    `4. Stay in my existing stack and framework. Replace styles and components; keep routing, data loading and the build setup.`,
    `   Put the design tokens in one place (CSS variables or the theme config) so the whole site uses them.`,
    `5. Run the site locally, check every page at 1440px desktop and 390px mobile, fix anything broken, and make sure the`,
    `   build passes. Finish with the list of pages you changed.`,
    ``,
    `If this repository is not my site's source code, stop and ask me where it is.`,
  ];
  return lines.filter(l => l !== null).join('\n') + '\n';
}
