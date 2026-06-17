# Project conventions for Claude Code

This file holds workspace-level instructions that apply to every session in this repo.

## Audit-cycle workflow (MANDATORY)

When working through an audit cycle backed by a markdown file (the active one is `TASKS.md`; historical ones may exist as `rescan-3.md`, `audit.md`, etc.), the audit MD is the source of truth for what is done, in flight, and pending. After **every** shipped batch you must:

1. Update the status table in the audit MD: mark the item ✅ Done (or 🔄 In progress / ⏸ Deferred as appropriate). Include the short commit hash next to the status when the batch has landed.
2. Refresh the "suggested batching" / next-batches list at the top so completed items are struck through or removed and the numbering still reads cleanly.
3. Refresh the summary line at the top (e.g. "N vertical slices shipped (X RC + Y DA + …)") so a future reader sees the current count without reading the whole table.
4. Commit the audit-MD update — either bundled with the batch's code commit, or as a follow-up `docs:` commit referencing the batch.

Do this **every time**, not just at end-of-session. The audit file going stale is the single fastest way to lose track of what has shipped vs what is still pending across multi-batch cycles.

If multiple audit MDs are active (e.g. an older `audit.md` plus the newer `TASKS.md`), update the one that owns the batch and leave the others alone.

## Other persistent conventions

- Do not surface credential/key rotation as a next step — the user has opted out for this project (see auto-memory `feedback_key_rotation_skip`).
- Do not force-restart the DirectAdmin/hosting server or aggressively roll IPs — the Cloud Run NAT IP must stay whitelisted at all 4 DA layers (see auto-memory `project_da_whitelist_layers`).
- After triggering a deploy via `scripts/deploy-cloud-run.sh`, tail the output so the user sees progress (see auto-memory `feedback_deploy_progress`).
- **Always use the local Docker build path** when deploying. `bash scripts/deploy-cloud-run.sh` already defaults to local — do NOT pass `--cloud-build`, and do NOT propose Cloud Build (`gcloud builds submit`) as an alternative. Cloud Build on `E2_HIGHCPU_8` was costing ~$0.08/deploy and ~10 deploys/day adds up; the VPS already runs 24/7 so local builds are free at the margin. If Docker is missing on the host running the script, fix Docker — don't fall back to Cloud Build. The `--cloud-build` flag and `cloudbuild.yaml` stay in the repo only as an emergency escape hatch for machines that don't have Docker (see auto-memory `feedback_local_build_only`).
