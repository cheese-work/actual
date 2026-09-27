# CHE-828 private Actual staging

`actual-staging.py` is a C00-only deployment helper. Build and test the image
on X99; C00 only pulls the published `master` digest. The helper never uses
production credentials, integrations, Docker sockets inside the staging
container, or the live-directory tar archive as a restore source.

## Safety model

- Every staging operation takes `/home/congvc/projects/oss/actual-budget/.actual-maintenance.lock`.
  The existing `backup.sh` cron and CHE-829 promotion must be changed to take
  that exact lock before this helper is enabled.
- Snapshots send production `SIGTERM` only, wait no longer than 20 seconds
  for capture, and never use Docker's kill-on-timeout stop path. A durable
  original-ID/image record lets the 25-second watchdog and boot recovery start
  only the exact production container interrupted by a refresh.
- Snapshot manifests audit every file and every SQLite database. Restore fails
  on a changed archive, unsupported account schema, copied sessions, auth,
  OpenID state, integration secrets, source config, or unpinned image.
- A candidate runs only on `actual-staging-isolated` and
  `127.0.0.1:15009`. The bridge must disable masquerading and have verified
  `DOCKER-USER` DROP rules for both its gateway and every production container
  IP. Promotion recreates `actual-staging` on `127.0.0.1:15008`; replacement
  and state commits roll back together.
- Promotion requires a private, authorized encrypted-budget verifier and a
  locally recorded tailnet ACL approval. Funnel is rejected. No generic CI
  runner or production bot has access.

## C00 rehearsal prerequisites

These are deliberate external gates; do not substitute the existing tar
archive or a production credential.

1. Change the existing tar job and CHE-829 promotion to use the shared lock:
   `flock -n /home/congvc/projects/oss/actual-budget/.actual-maintenance.lock <existing-command>`.
2. Create `actual-staging-isolated` as an internal Docker bridge with
   `com.docker.network.bridge.enable_ip_masquerade=false` and a stable bridge
   name. Add `INPUT -> ACTUAL_STAGING_INPUT` and
   `DOCKER-USER -> ACTUAL_STAGING_FORWARD` hooks for that bridge. Earlier
   rules may only be unrelated-interface traffic or scoped
   `ESTABLISHED,RELATED` replies; no earlier jump, goto, RETURN, or NEW
   accept is allowed. Each hook must match only the bridge interface, and each
   required DROP must match only the staging subnet and exact gateway or
   production IP: no protocol, port, source-host, destination-host, or
   connection-state predicate. Create
   `ROOT/password.hash` mode `0600` from a staging-only password through the
   image's Argon2 implementation.
3. Configure Tailscale Serve to the staging origin at `127.0.0.1:15008`,
   apply a tailnet ACL limited to authorized users, verify Funnel is disabled,
   then write private `ROOT/tailnet-authorized.json`:

   ```json
   {"host":"staging-hostname.tailnet.ts.net","funnel":false}
   ```

4. Install private executable `ROOT/verify-encrypted-budget`. It receives the
   snapshot name, pinned image digest, and candidate identity, performs the
   authorized login and decrypt check without printing a secret, and exits
   nonzero on failure. Also create
   `~/.config/actual-staging/alert.env` mode `0600` containing
   `ACTUAL_ALERT_TARGET=<approved-target>` for scheduled alerts.

## Rehearsal sequence

Run only under the recorded 30-second interruption approval. The transient
watchdog fires after 20 seconds with timer accuracy forced to 1 microsecond;
if arming fails, snapshot capture does not start. Preserve command output,
container IDs, image digests, alert receipt, and cleanup evidence.

1. `python3 ops/actual-staging.py install-units`
2. `ACTUAL_ALERT_TARGET=<approved-target> python3 ops/actual-staging.py alert-test`
3. `python3 ops/actual-staging.py refresh`
4. Confirm the authorized encrypted-budget verifier, staging version, source
   count, tailnet-only access, prior-generation rollback, and production
   container identity.
5. `python3 ops/actual-staging.py enable-units`

The daily refresh is `03:45`; a five-minute image-sync timer pulls published
`master` and promotes it from the latest approved snapshot only, without a
second production interruption or freshness reset. The freshness timer alerts
after 26 hours or any recorded refresh failure and runs retention even when a
refresh failed. Completed snapshots are retained for 14 days; failed spools,
partial archives, and expired unreferenced generations are removed.

The X99 offline suite is:

```bash
python3 -m unittest discover -s ops -p 'test_actual_staging.py' -v
```
