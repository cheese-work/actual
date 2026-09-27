# CHE-828 private Actual staging

`actual-staging.py` is a C00-only deployment helper. Build and test the image
on X99; C00 only pulls the published `master` digest. The helper never uses
production credentials, integrations, Docker sockets inside the staging
container, or the live-directory tar archive as a restore source.

## Safety model

- Every staging operation takes `/home/congvc/projects/oss/actual-budget/.actual-maintenance.lock`.
  The existing `backup.sh` cron and CHE-829 promotion must be changed to take
  that exact lock before this helper is enabled.
- Snapshots use `docker stop --time 10` under a transient 30-second watchdog.
  `actual-prod-watchdog.service` separately starts the exact unchanged
  production container after boot or an interrupted refresh.
- Snapshot manifests audit every file and every SQLite database. Restore fails
  on a changed archive, unsupported account schema, copied sessions, auth,
  OpenID state, integration secrets, source config, or unpinned image.
- A candidate runs only on the internal `actual-staging-isolated` network and
  `127.0.0.1:15009`. Promotion recreates `actual-staging` on
  `127.0.0.1:15008`; a failed replacement recreates the prior generation.
- Promotion requires a private, authorized encrypted-budget verifier and a
  locally recorded tailnet ACL approval. Funnel is rejected. No generic CI
  runner or production bot has access.

## C00 rehearsal prerequisites

These are deliberate external gates; do not substitute the existing tar
archive or a production credential.

1. Change the existing tar job and CHE-829 promotion to use the shared lock:
   `flock -n /home/congvc/projects/oss/actual-budget/.actual-maintenance.lock <existing-command>`.
2. Create `actual-staging-isolated` as an internal Docker bridge. Create
   `ROOT/password.hash` mode `0600` from a staging-only password through the
   image's Argon2 implementation.
3. Configure Tailscale Serve to the staging origin at `127.0.0.1:15008`,
   apply a tailnet ACL limited to authorized users, verify Funnel is disabled,
   then write private `ROOT/tailnet-authorized.json`:

   ```json
   {"host":"staging-hostname.tailnet.ts.net","funnel":false}
   ```

4. Install private executable `ROOT/verify-encrypted-budget`. It receives the
   snapshot name and pinned image digest, performs the authorized login and
   decrypt check without printing a secret, and exits nonzero on failure.

## Rehearsal sequence

Run only under the recorded 30-second interruption approval. Preserve command
output, container IDs, image digests, alert receipt, and cleanup evidence.

1. `python3 ops/actual-staging.py install-units`
2. `ACTUAL_ALERT_TARGET=<approved-target> python3 ops/actual-staging.py alert-test`
3. `python3 ops/actual-staging.py refresh --image <published-pinned-digest>`
4. Confirm the authorized encrypted-budget verifier, staging version, source
   count, tailnet-only access, prior-generation rollback, and production
   container identity.
5. `python3 ops/actual-staging.py enable-units`

The daily refresh is `03:45`; a five-minute image-sync timer pulls published
`master` and refreshes only when its pinned digest changes. The freshness timer
alerts after 26 hours. Completed snapshots are retained for 14 days; partial
archives and active generations are never selected as restore sources.

The X99 offline suite is:

```bash
python3 -m unittest discover -s ops -p 'test_actual_staging.py' -v
```
