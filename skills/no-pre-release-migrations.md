# No Pre-Release Migrations

**Trigger:** Adding SQL schema in this repo before the first user-facing tagged release.

## Rule

- Extend the `CREATE TABLE IF NOT EXISTS` block directly.
- Do not add `ALTER TABLE` migration code paths, version tables, or up/down migration files.
- Operators wipe their DB to pick up schema changes; document this in the changelog when releases start.
- Real migrations land when the project ships a tagged release that real users depend on.

## Examples

### Bad

```ts
db.exec(`CREATE TABLE IF NOT EXISTS assets (cid TEXT PRIMARY KEY)`)
// migration v2
const cols = db.prepare(`PRAGMA table_info(assets)`).all()
if (!cols.find(c => c.name === 'size')) {
  db.exec(`ALTER TABLE assets ADD COLUMN size INTEGER`)
}
```

### Good

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    cid TEXT PRIMARY KEY,
    size INTEGER
  )
`)
```

## Why

Migration code carries permanent maintenance cost. Before a project has real users, the cost buys nothing because operators can wipe and re-run.
