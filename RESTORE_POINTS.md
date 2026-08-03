# Known-good restore points

Tagged Docker images + Cloud Run revisions that the operator has explicitly
marked as "working" — for fast rollback when a future deploy regresses.

Each entry includes:
- The Cloud Run revision (rollback via traffic-shift, no rebuild needed)
- The Artifact Registry image tag + digest (rollback via a fresh deploy
  pinned at this image, used when the revision has been garbage-collected
  by Cloud Run's retention policy)
- A short description of what the image contains so the right one is easy
  to pick.

When adding a new entry: tag the image in Artifact Registry with
`stable-YYYY-MM-DD` (auto-discoverable by date) **AND** a semantic name
like `known-good-<what-it-fixes>` (so the intent is grep-able). Use
`gcloud artifacts docker tags add` — see the examples below.

---

## 2026-08-01 — `dms-00452-z2x` / `known-good-pre-sub-reseller` (before the sub-reseller feature)

**Cloud Run revision**: `dms-00452-z2x` (serving 100%, health 200 at snapshot)
**Deployed image (by digest)**: `us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms@sha256:042c88397ec08cf043286411e0adb1a2f4bee1632f71093fa90a1654cd26be1e` (built from git `4569110`)
**Image digest**: `sha256:042c88397ec08cf043286411e0adb1a2f4bee1632f71093fa90a1654cd26be1e`
**Image tags**: ✅ `stable-2026-08-01` + `known-good-pre-sub-reseller` (both applied to the digest above via `gcloud artifacts docker tags add`)
**Git HEAD**: `deb004c` (docs) on top of deployed code `4569110` (`refactor(db): tighten PendingDomain _id`)
**Git tag**: `restore-2026-08-01-pre-sub-reseller` (annotated, pushed — the durable source anchor)
**Operator note**: Snapshot taken **before** starting the **sub-reseller** feature (letting our customers act as resellers under our own panel). This is the clean rollback target if that build regresses. Contains the full close-out of the backlog session: paid-hosting domain guard (airtight), guest set-password email fix, the complete Meta Analytics work (CAPI dedup + beacon rate-limit + sync-path conversions), the entire mobile audit (CRITICAL + MAJOR + all 10 MINOR), the a11y CI ratchet gate, the admin-page safe split, and the PendingDomain `_id` tightening. Razorpay still in **TEST mode** (no live cutover yet); **no sub-reseller code**.

### Rollback paths (fastest first)

**Path 1 — traffic-shift** (no rebuild, instant):
```bash
gcloud run services update-traffic dms --region=europe-west1 --to-revisions=dms-00452-z2x=100
```

**Path 2 — redeploy the tag** (if the revision was GC'd; after the image tags above are applied):
```bash
gcloud run deploy dms \
  --image=us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:known-good-pre-sub-reseller \
  --region=europe-west1
```

**Path 3 — rebuild from source**: `git checkout restore-2026-08-01-pre-sub-reseller` (or `4569110`) then `bash scripts/deploy-cloud-run.sh`.

---

## 2026-07-18 — `dms-00350-92n` / `known-good-pre-meta-capi` (before the Meta CAPI / analytics build)

**Cloud Run revision**: `dms-00350-92n` (serving 100%, health 200 at snapshot)
**Image digest**: `sha256:280475f60a283df301dae411a53df849b02fcef1b21f034ad828fe89d667f5ea`
**Image tags**: `stable-2026-07-18-analytics-base` + `known-good-pre-meta-capi`
**Git HEAD**: `984a470` (docs) on top of deployed code `dec83cf` (`feat(tracking): SPA route-change PageView tracking + admin toggle`)
**Operator note**: Snapshot taken **before** starting the Meta Tracking & Analytics SRS build (Meta Pixel browser events + Conversions API server events + internal customer activity/lead-scoring + UTM/fbclid attribution + event dedup). This is the clean rollback target if that build regresses. Contains the full page-manager work (Phase 1+2), the hosting-landing redesign + colour/toggle/footer work, the footer switcher, the homepage-disable swap, and the SPA-pageview tracking + admin toggle.

### Rollback paths (fastest first)

**Path 1 — traffic-shift** (no rebuild): `gcloud run services update-traffic dms --region=europe-west1 --to-revisions=dms-00350-92n=100`

**Path 2 — redeploy the tag** (if the revision was GC'd):
```bash
gcloud run deploy dms \
  --image=us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:stable-2026-07-18-analytics-base \
  --region=europe-west1
```

**Path 3 — rebuild from source**: `git checkout dec83cf` then `bash scripts/deploy-cloud-run.sh`.

---

## 2026-07-18 — `dms-00342-zzx` / `known-good-hosting-landing` (hosting-trial landing homepage)

**Cloud Run revision**: `dms-00342-zzx` (serving 100%, health 200 at snapshot)
**Deployed image tag**: `us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:833b98b0` (built from git `833b98b`)
**Image digest**: `sha256:456b2174098406c48755c370556e86d9a5dd5c88ef88cbb777e47393541a760a`
**Image tags**: `stable-2026-07-18-landing` + `known-good-hosting-landing`
**Git HEAD**: `833b98b` (`feat(nav): add Domains link pointing to /domains-home`)
**Operator note**: The state at the close of the page-manager work. Contains: the admin **Pages** publish/draft manager (Phase 1, `dms-00340-t4w`), the **hosting 15-Day Free Trial landing as the homepage** with DB-driven pricing + the domain homepage relocated to `/domains-home` (Phase 2, `dms-00341-9b8`), and the **Domains** nav link (`dms-00342-zzx`). Live smoke at snapshot: `/` (hosting landing, 3 DB plans), `/domains-home`, `/hosting`, `/about`, `/contact` → 200; admin Pages API unauth → 401.

### Rollback paths (fastest first)

**Path 1 — Cloud Run revision traffic-shift** (no rebuild, instant):
```bash
gcloud run services update-traffic dms --region=europe-west1 --to-revisions=dms-00342-zzx=100
```

**Path 2 — Re-deploy from the stable image tag** (when the revision has been GC'd):
```bash
gcloud run deploy dms \
  --image=us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:stable-2026-07-18-landing \
  --region=europe-west1
```

**Path 3 — Rebuild from source**: `git checkout 833b98b` then `bash scripts/deploy-cloud-run.sh`.

---

## 2026-07-18 — `dms-00338-6vr` / `known-good-mobile-hero-readme` (source-verified restore point)

**Cloud Run revision**: `dms-00338-6vr` (serving 100%, health 200 at snapshot)
**Deployed image tag**: `us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:ebef6f97` (built from git `ebef6f9`)
**Image digest**: `sha256:781b6c100771ea1afacc8c9ffa32a737731dfa8d66d3f1747288baf3217a8575`
**Image tags**: `stable-2026-07-18` + `known-good-mobile-hero-readme` (applied 2026-07-18 after reauth).
**Git HEAD**: `5ecb7c8` (`docs: add project README`) — HEAD is two `[skip ci]` docs-only commits (`4e74a18` TASKS flip, `5ecb7c8` README) **on top of** the last deployed code commit `ebef6f9`, so the running image does NOT contain the README/TASKS docs, but the source tree does. Rolling the image back to this revision is safe (docs aren't runtime).
**Operator note**: Marked as a **crucial restore point** after a full local teardown + rebuild cycle. Sequence:

1. Operator backed up the project source, then had `node_modules` + `.next` deleted for a clean archive.
2. **Restore verified end-to-end** on 2026-07-18: `npm install` → 659 packages, exit 0; `npx tsc --noEmit` → clean (exit 0); `npm run build` → clean production build with full route table, exit 0; `git status` clean; HEAD pushed to origin/main.
3. This is the known-good state at the close of the homepage domain-refocus + mobile-hero work (revisions `dms-00330`→`dms-00338`): domain-focused homepage, removed hosting/stats sections, hero search-button polish, taller mobile hero (`min-h-[80vh]`), plus the new `README.md`. The mobile-compatibility audit (2 CRITICAL / 7 MAJOR / 10 MINOR) is logged as PENDING in `TASKS.md` — none of those fixes are in this image.

### Applying the `stable-2026-07-18` tag (after `gcloud auth login`)
```bash
export CLOUDSDK_PYTHON="C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\platform\bundledpython\python.exe"
# tag the currently-deployed image with a date tag + a semantic known-good tag
gcloud artifacts docker tags add \
  us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:ebef6f97 \
  us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:stable-2026-07-18
gcloud artifacts docker tags add \
  us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:ebef6f97 \
  us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:known-good-mobile-hero-readme
```

### Rollback paths (fastest first)

**Path 1 — Cloud Run revision traffic-shift** (no rebuild, instant):
```bash
gcloud run services update-traffic dms   --region=europe-west1   --to-revisions=dms-00338-6vr=100
```

**Path 2 — Re-deploy from the stable image tag** (once `stable-2026-07-18` is applied, use when the revision has been GC'd):
```bash
gcloud run deploy dms   --image=us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:stable-2026-07-18   --region=europe-west1
```

**Path 3 — Rebuild from source** (git is the source of truth): `git checkout 5ecb7c8` (or `ebef6f9` for exactly the deployed code) then `bash scripts/deploy-cloud-run.sh`.

---

## 2026-06-29 — `dms-00207-jvz` / post-MongoDB-credential-rotation

**Cloud Run revision**: `dms-00207-jvz`
**Image digest**: same as `dms-00206-z6j` (image unchanged — only an env-var nudge `MONGODB_ROTATION_TS` was added to force a new revision binding to Secret Manager v2)
**Git commit**: `a5b6272` (`sec(hooks): pre-commit hook blocks secrets reaching git`)
**Operator note**: Marked stable after the 2026-06-29 security incident remediation. Sequence of events documented for the audit trail:

1. **Leak detected** — security review found a MongoDB Atlas connection string with the database user's password embedded directly in the URL (a `mongodb+srv://...` connection string) in git history. File `test-full-app.js` committed in initial commit `2ceee43`, removed from working tree in `a1761c2`, but readable via `git log -p` until today's force-push. Specific password value intentionally not reproduced here — see commit `a5b6272` for the pre-commit hook that prevents that pattern from being re-committed.
2. **Password rotated in Atlas** — operator (pawan@anutech.in) rotated the database user `pawan`'s password via Atlas console. Old password died immediately.
3. **Secret Manager v2 pushed** — new MONGODB_URI written via `gcloud secrets versions add MONGODB_URI --data-file=-` (heredoc; password never in shell history or chat).
4. **Cloud Run env-var nudge** — `gcloud run services update dms --update-env-vars="MONGODB_ROTATION_TS=..."` forced a new revision without rebuilding the image. Revision `dms-00207-jvz` came up serving 100% on the new password. Health check 200; admin endpoints 401 (auth check ran = DB reach OK); zero ERROR logs.
5. **Git history rewritten** — `git filter-branch --index-filter "git rm --cached --ignore-unmatch test-full-app.js" -- --all` purged the file from all 6000+ commits. SHAs all changed. 147 deploy tags also rewritten.
6. **Force-pushed to GitHub** — main + all tags. Remote credential count: 0.
7. **Hard-rule defence added** — pre-commit hook at `.husky/pre-commit` → `scripts/check-staged-for-secrets.sh` greps staged hunks for MongoDB URIs, Razorpay key secrets, Anthropic keys, AWS keys, GCP SA private_key fields, PEM private-key blocks, and env-var-shape secret assignments. Blocks the commit on any match. End-to-end tested (real `git commit` blocked correctly).

Pre-rewrite history snapshot (in case the rewrite needs to be undone) is preserved locally at `refs/original/refs/heads/main` (SHA `b022162`). It's NOT on the remote and will be GC'd in ~90 days unless explicitly preserved.

### Rollback paths

This is NOT a rollback target in the traditional sense — there's no "stable image" tagged for this entry because the image was unchanged from `dms-00206-z6j`. But for completeness:

**Path 1 — Cloud Run revision traffic-shift** (instant, no rebuild):
```bash
gcloud run services update-traffic dms \
  --project=speedy-unison-453807-e9 \
  --region=europe-west1 \
  --to-revisions=dms-00206-z6j=100
```
Note: rolling back to `dms-00206-z6j` would mean a pod restart that re-reads Secret Manager `:latest` (= v2 = new password). So even the pre-rotation revision would now use the post-rotation password. The old (rotated) password is dead in Atlas regardless.

**Path 2 — Revert the pre-commit hook** (if it's blocking legitimate commits — should be vanishingly rare): edit `.husky/pre-commit` to comment out the `check-staged-for-secrets.sh` line, or use `git commit --no-verify`. Don't loosen the scanner regex itself; if it's a false positive, fix the input.

**Path 3 — Restore pre-rewrite git history** (if the rewrite caused an unforeseen issue): while `refs/original/refs/heads/main` still exists locally:
```bash
git update-ref refs/heads/main refs/original/refs/heads/main
git push --force origin main
```
This puts the leaked credential back in remote history. Only do this if you're prepared to immediately re-rotate the credential AND redo the rewrite + force-push cycle.

---

## 2026-06-22 — `stable-2026-06-22` / `known-good-hosting-chain-closed`

**Cloud Run revision**: `dms-00205-2zv`
**Image digest**: `sha256:ec8d429dc59763537cb7203d681b6c3e494c0c4ed3c68c8fb35420e40f5428f9`
**Git commit**: `f87b7375` (`fix(integration-health): classify 'Invalid Domain Name' DA error with actionable hint`)
**Operator note**: Marked stable at the close of today's 20-deploy
hosting-chain saga. All code-side fixes (linkedDomain inference, raw-error
preservation, customer/admin error split, Integration Health admin page,
DA-server-switch with new IP wiring, package-name resolution, lazy-load on
hosting list, real disk/bandwidth display, auto-detect state normaliser,
classifier hints for every DA error pattern hit during today's
investigation, captcha re-introduction end-to-end) are in this image. The
only outstanding items at the snapshot were operator-side: DA `valid_TLDs`
whitelist, DA nameserver hostnames update, ResellerClub balance top-up —
none of those are in the codebase, so a rollback to this image is safe.

### Rollback paths (fastest first)

**Path 1 — Cloud Run revision traffic-shift** (no rebuild, instant):
```bash
gcloud run services update-traffic dms \
  --region=europe-west1 \
  --to-revisions=dms-00205-2zv=100
```
This works as long as the revision is still present in Cloud Run's
revision list (`gcloud run revisions list --service=dms --region=europe-west1`).
Cloud Run keeps the last 100 revisions by default — past that, the
revision is garbage-collected.

**Path 2 — Re-deploy from the stable image tag** (use when the revision
above has been cleaned up):
```bash
gcloud run deploy dms \
  --image=us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:stable-2026-06-22 \
  --region=europe-west1
```
The tag is immutable as long as nobody re-tags the image. Adding new
versions to Cloud Run from this image works regardless of revision GC.

**Path 3 — Re-deploy from digest** (use when even the tag has been
overwritten — paranoid mode):
```bash
gcloud run deploy dms \
  --image=us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms@sha256:ec8d429dc59763537cb7203d681b6c3e494c0c4ed3c68c8fb35420e40f5428f9 \
  --region=europe-west1
```
The digest is the cryptographic content hash — pulls THIS exact bit-for-bit
image regardless of any tag manipulation.

---

## Adding a new restore point

After confirming a deploy is working (full smoke test + a few hours of
production traffic), tag it:

```bash
# Find the git SHA of the current Cloud Run revision (it's used as the
# image tag at deploy time):
GIT_SHA=$(gcloud run services describe dms --region=europe-west1 \
  --format="value(spec.template.spec.containers[0].image)" | \
  sed 's/.*://')

# Add two tags — date-based (auto-discoverable) + semantic (intent-grep-able).
DATE=$(date +%Y-%m-%d)
gcloud artifacts docker tags add \
  "us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:$GIT_SHA" \
  "us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:stable-$DATE"

gcloud artifacts docker tags add \
  "us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:$GIT_SHA" \
  "us-central1-docker.pkg.dev/speedy-unison-453807-e9/dms/dms:known-good-<short-description>"
```

Then append a new section to this file at the top (newest first).
