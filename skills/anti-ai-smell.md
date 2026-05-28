Source: ~/.claude/skills/github-writing/SKILL.md

# Anti-AI Smell

**Trigger:** Writing any prose for humans (docs, issues, PRs, commit messages).

## Rule

- Do not use these words: `Additionally`, `Furthermore`, `It is worth noting`, `comprehensive`, `robust`, `leverages`, `facilitates`, `ensure`.
- No closing summary that repeats the body.
- No symmetrical bullet lists that flatten every point to equal weight.
- No headings for one-sentence sections. No bullet lists with only one item.
- Em dashes are fine when natural. Avoid the contrastive sandwich construction with em dashes (see Bad example below).

## Examples

### Bad

This library leverages a robust event system to facilitate comprehensive progress reporting — not a callback soup, but a unified stream. It is worth noting the design is clean.

### Good

The library reports progress through a single event stream. See `events.ts`.

## Why

These markers signal AI-generated filler and erode reader trust. Cutting them forces the writer to say something specific.
