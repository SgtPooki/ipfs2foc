Source: ~/.claude/skills/github-writing/SKILL.md

# GitHub Issue Structure

**Trigger:** Opening or editing a GitHub issue.

## Rule

- Title follows the repo's convention. If typed prefixes are used: `[Type]: brief specific description`. No vague titles like `fix migration issue`.
- Body sections in order: Description, Impact, Steps to Reproduce, Expected Behavior, Actual Behavior, Environment, Additional Context.
- Omit any section that has nothing useful. Steps/Expected/Actual apply to bugs; Environment only when relevant.
- Target ~150–250 words. The body must stand alone with no private-conversation context.
- Link related issues and docs rather than restating them.

## Examples

### Bad

Title: `fix dataset bug`

Body: As we discussed, the thing is broken. See chat. Please fix soon.

### Good

Title: `[Bug]: migrated datasets are hidden from the dataset list view`

Body, in order, each as a short paragraph:

- **Description:** the dataset list omits any dataset created through the migration path; manual queries against the DB show the row exists with `status = committed`.
- **Impact:** operators cannot see migrated datasets in the UI; they assume the migration silently dropped them.
- **Steps to Reproduce:** 1. run `ipfs2foc plan --cids cids.txt`, 2. run `ipfs2foc pdp-submit ...`, 3. open the dataset list.
- **Expected:** the migrated dataset appears with status `committed`.
- **Actual:** the list is empty.
- **Environment:** Node 26, sqlite default DB, mainnet.
- **Additional Context:** repro DB at `gist://.../migrate.db`, investigation memo at `gist://.../memo.md`.

## Why

A reader should grasp the problem, impact, and next action in under 60 seconds without backchannel context.
