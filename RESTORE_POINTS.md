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
