---
title: Kimaki visual design
description: >
  Brand assets and visual rules for Kimaki interfaces, charts, social images,
  and generated graphics.
---

# Kimaki visual design

Kimaki uses a **dark, precise, editorial** visual style. Graphics should feel
like a well-designed developer tool, not a futuristic AI advertisement.

## Brand assets

Use the original files as image references. Do not redraw the logo from text.

| Asset | Path | Use |
|---|---|---|
| Primary logo | `website/public/logo.jpeg` | Exact pixelated Gothic `K` mark |
| Padded logo | `website/public/logo-padding.jpeg` | Reference with extra negative space |

The logo is a white, aliased Gothic `K` on pure black. Preserve its stepped
pixel edges, split vertical stem, left spurs, and curved right limbs. Do not
smooth, recolor, glow, bevel, or reinterpret it.

For wide graphics, place the `K` at the top left. The lowercase word `kimaki`
can follow in Inter, but the `K` remains the primary identifying mark.

## Colors

### Core interface colors

| Role | Value | Source |
|---|---|---|
| Primary | `#5865F2` | `website/docs.json` |
| Hero light | `#8DA4FF` | `website/src/components/hero-section.tsx` |
| Light background | `#FFFFFF` | Holocron default |
| Light foreground | `#09090B` | Holocron neutral foreground |
| Dark background | `#0D0D10` | Holocron dark background |
| Dark foreground | `#FAFAFA` | Holocron dark foreground |
| Dark structural border | `rgba(255,255,255,0.12)` | Holocron default |
| Dark divider | `rgba(255,255,255,0.06)` | Holocron default |

Use `#5865F2` as the **primary brand color**. On dark backgrounds, use the
lighter `#8DA4FF` for large chart marks and active emphasis.

### Data visualization palette

Use this accessible expansion of the interface palette:

| Series role | Color |
|---|---|
| Primary series or cache reads | `#8DA4FF` |
| Secondary series or fresh input | `#FF8A78` |
| Tertiary series or cache writes | `#F3C969` |
| Positive/output series | `#58D6B7` |
| Reasoning/supporting series | `#C4B5FD` |
| Muted or unavailable series | `#777680` |

Each semantic series gets one continuous fill color. Do not split one series
into several shades unless the legend explains those shades.

## Typography

| Role | Font | Treatment |
|---|---|---|
| Interface and chart text | Inter Variable | Regular 400, prose 475 |
| Headings and KPI numbers | Inter Variable | Semibold 560 to bold 700 |
| Code, ticks, or technical labels | JetBrains Mono Variable | Regular 400 to medium 500 |
| Marketing display accent | Playfair Display | Italic, used sparingly |

Use Inter for graph headlines, labels, legends, and numbers. Use JetBrains Mono
only when a technical or tabular tone helps. Reserve italic Playfair Display
for one short marketing phrase, never chart labels or dense data.

## Layout

Default graph composition:

1. Logo and wordmark at top left.
2. Small uppercase eyebrow with date range and source.
3. One large sentence-case headline.
4. One dominant chart with direct value labels.
5. Compact legend and source note at the bottom.

Use generous negative space and left alignment. Prefer landscape `3:2` for
Discord and social sharing. Use portrait `2:3` only when the destination is
explicitly vertical.

## Borders, radius, and depth

Kimaki documentation disables decorative grid lines with
`"decorativeLines": "none"` in `website/docs.json`.

- Do not draw an outer frame around the graphic.
- Use thin structural axes and grid lines at low contrast.
- Use `1px` subtle borders only when they clarify grouping.
- Prefer square chart geometry and small radii from `0px` to `10px`.
- Use no card shadow by default.
- Avoid glass panels, heavy gradients, glowing tubes, bevels, and 3D charts.
- Do not put every metric in a card. Let typography and spacing create groups.

## Image-generation references

Pass references in this order:

1. Editorial layout or chart reference.
2. `website/public/logo.jpeg` for exact logo geometry.
3. Optional website screenshot for mood and spacing.

Tell the model what each image controls. A layout image must not override the
Kimaki colors or logo. A logo image must not force its large black canvas into
the final composition.

## Data graphics

- Use exact text and values supplied by the data source.
- Use one main finding per image.
- Prefer bars for time and rankings, and one horizontal stacked bar for a
  two-part composition.
- State whether a period is rolling or calendar-based.
- Include cache usage when it materially changes the meaning of token totals.
- Add a concise source and date note.
- Never add decorative data, unexplained colors, or invented labels.

For token throughput, distinguish **total tokens**, **cache reads**, and
**fresh or generated work**. Do not present cache-inclusive throughput as
full-price compute.
