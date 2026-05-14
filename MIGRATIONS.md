# Database Migrations

This project uses a simple, file-based migration system for MongoDB. The framework lives in [scripts/db/migrate.ts](scripts/db/migrate.ts); migrations live in [scripts/db/migrations/](scripts/db/migrations/). Applied migrations are tracked in the `_migrations` collection in MongoDB — each migration runs exactly once per database.

## When to write a migration

Write a migration whenever a deploy would otherwise leave **existing databases in a state the new code cannot handle**. The most common cases:

- New required field on a document where existing rows would be missing it (backfill the field)
- New compound index that the new code's queries depend on (`createIndex`)
- Data shape change (renamed field, restructured sub-document, type change)
- Dropping a field or index that is no longer used and is expensive to keep

You do **not** need a migration when:

- You only add new optional fields with sensible defaults (Mongoose handles this transparently)
- You add a new collection (Mongoose creates it on first write)
- You add a non-critical index that can be left to Mongoose's `autoIndex` (still preferred to write a migration for production determinism)

## File naming

```
scripts/db/migrations/NNN_short_description.ts
```

- `NNN` — zero-padded sequence number, monotonically increasing. Check the current highest in [scripts/db/migrations/](scripts/db/migrations/) and add one.
- `short_description` — snake_case, ideally under 60 characters.

Examples that already exist:

- `001_add_domain_indexes.ts`
- `002_add_domain_soft_delete_fields.ts`
- `003_add_order_indexes.ts`
- `004_add_user_pending_hosting_support_ticket_indexes.ts`

## File template

Every migration exports `up(db)` and `down(db)`. Both receive the active Mongoose `Connection`.

```ts
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const collection = db.collection("name_of_collection");
  // make the change
  await collection.createIndex({ field: 1 }, { background: true });
}

export async function down(db: Connection) {
  const collection = db.collection("name_of_collection");
  // reverse it
  await collection.dropIndex("field_1").catch(() => {});
}
```

Notes:

- Always use `{ background: true }` for `createIndex` — non-background builds lock the collection.
- Wrap `dropIndex` in `.catch(() => {})` because the index may not exist on every environment (idempotent rollback).
- The `up` step is idempotent **at the collection level only** — the runner ensures it never runs twice on the same DB by recording the filename in `_migrations`.

## Commands

| Command | What it does |
|---|---|
| `npm run migrate:status` | Lists every migration in the directory and marks each as applied or pending. Read-only. |
| `npm run migrate:dry` | Lists pending migrations without applying them. |
| `npm run migrate` | Applies every pending migration in order. Stops on first failure. |

All three load `MONGODB_URI` from [.env.local](.env.local).

## Local development workflow

1. Write the new migration file under [scripts/db/migrations/](scripts/db/migrations/).
2. Update the corresponding Mongoose schema in [models/](models/) so new databases (no migration history needed) and Mongoose's `autoIndex` produce the same end state.
3. `npm run migrate:status` — confirm the new file shows as pending.
4. `npm run migrate:dry` — sanity check.
5. `npm run migrate` — apply locally and verify the app still works.
6. Commit the migration file together with the schema change in a single commit.

## Production deployment

[deploy.sh](deploy.sh) runs `npm run migrate:status` and then `npm run migrate` automatically between build and start. A failing migration aborts the deploy:

- Build artifacts are produced ✅
- DB is unchanged ❌ (migration failed before applying it)
- Old standalone server process is already gone ⚠️ — operator must investigate and either fix the migration or roll back the deploy

Logs land at `deployment-logs/<timestamp>/migrate.log`.

## Rollback

There is **no automatic rollback**. If a migration causes a problem post-deploy:

1. Stop the standalone server process (`kill -TERM "$(cat deployment-logs/.server.pid)"`, or stop the systemd / Cloud Run service that supervises it).
2. Run the migration's `down(db)` manually via a one-off ts-node invocation, or revert the data change by hand if the impact is small.
3. Delete the migration's row from the `_migrations` collection so the runner will re-attempt on the next deploy:
   ```
   db._migrations.deleteOne({ name: "NNN_filename.ts" })
   ```
4. Fix the migration code, redeploy.

For schema changes you can never undo (e.g., dropped fields), do the change behind a feature flag: the migration goes out first as a no-op + a flag, and you flip the flag once you have confidence.

## Safety checklist before merging a migration

- [ ] File name matches `NNN_description.ts` pattern, NNN is the next sequential number
- [ ] `up()` and `down()` both implemented
- [ ] `createIndex` calls use `{ background: true }`
- [ ] `dropIndex` calls are wrapped in `.catch(() => {})` for idempotent rollback
- [ ] Tested locally with `npm run migrate` against a non-empty dataset
- [ ] Matching schema change in [models/](models/) is in the same commit
- [ ] No code in [app/](app/) or [lib/](lib/) depends on the migration's effect until the migration is merged (otherwise a rollback strands users on the new code with the old DB)
