"""Offline staging checks; run on X99 with python3 -m unittest discover -s ops."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('actual_staging', Path(__file__).with_name('actual-staging.py'))
assert spec is not None and spec.loader is not None
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'server-files').mkdir()
        (self.root / 'user-files').mkdir()
        self.db = self.root / 'server-files/account.sqlite'
        with sqlite3.connect(self.db) as db:
            db.executescript('''
                CREATE TABLE files(id TEXT, deleted INTEGER);
                INSERT INTO files VALUES ('fixture', 0);
                CREATE TABLE sessions(token TEXT, user_id TEXT, auth_method TEXT);
                INSERT INTO sessions VALUES ('fixture', 'fixture', 'password');
                CREATE TABLE auth(method TEXT, display_name TEXT, extra_data TEXT, active INTEGER);
                INSERT INTO auth VALUES ('password', 'Password', 'prod-hash-fixture', 1);
                CREATE TABLE secrets(name TEXT, value TEXT);
                INSERT INTO secrets VALUES ('bank', 'fixture');
                CREATE TABLE pending_openid_requests(state TEXT);
                INSERT INTO pending_openid_requests VALUES ('fixture');
                CREATE TABLE users(user_name TEXT, owner INTEGER, enabled INTEGER);
                INSERT INTO users VALUES ('', 1, 1);
            ''')
        with sqlite3.connect(self.root / 'user-files/group-fixture.sqlite') as db:
            db.execute('CREATE TABLE messages_binary(value BLOB)')
            db.execute('INSERT INTO messages_binary VALUES (?)', (b'fixture',))

    def tearDown(self):
        self.tmp.cleanup()

    def test_sanitize_revokes_all_copied_auth_but_keeps_budget(self):
        self.assertEqual(staging.budget_count(self.root), 1)
        self.assertEqual(staging.sanitize(self.root, '$argon2id$fixture'), 1)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM secrets').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM pending_openid_requests').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT extra_data FROM auth').fetchone()[0], '$argon2id$fixture')

    def test_unknown_schema_fails_closed(self):
        with sqlite3.connect(self.db) as db:
            db.execute('DROP TABLE secrets')
        with self.assertRaisesRegex(ValueError, 'unsupported auth schema'):
            staging.sanitize(self.root, '$argon2id$fixture')

    def test_symlink_and_corruption_rejected(self):
        (self.root / 'user-files/link').symlink_to(self.db)
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            staging.audit(self.root)
        (self.root / 'user-files/link').unlink()
        with self.db.open('r+b') as stream:
            stream.write(b'corruption')
        with self.assertRaises(sqlite3.DatabaseError):
            staging.budget_count(self.root)

    def test_retention_removes_only_expired_completed_snapshots(self):
        snapshots = self.root / 'snapshots'
        snapshots.mkdir()
        old = snapshots / 'actual-consistent-old'
        old.mkdir()
        recent = snapshots / 'actual-consistent-recent'
        recent.mkdir()
        partial = snapshots / '.actual-consistent-old.partial'
        partial.mkdir()
        old_time = 1
        os.utime(old, (old_time, old_time))
        os.utime(partial, (old_time, old_time))

        staging.cleanup_snapshots(snapshots, now=15 * 86400, keep_days=14)

        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(partial.exists())

    def test_systemd_units_keep_boot_recovery_and_refresh_separate(self):
        units = staging.systemd_units(Path('/srv/actual/ops/actual-staging.py'))

        self.assertIn('actual-prod-watchdog.service', units)
        self.assertIn('ExecStart=/usr/bin/python3 /srv/actual/ops/actual-staging.py recover', units['actual-prod-watchdog.service'])
        self.assertIn('EnvironmentFile=%h/.config/actual-staging/alert.env', units['actual-staging-refresh.service'])
        self.assertIn('OnCalendar=*-*-* 03:45:00', units['actual-staging-refresh.timer'])
        self.assertIn('Persistent=true', units['actual-staging-freshness.timer'])
        self.assertIn('OnUnitInactiveSec=5min', units['actual-staging-image-sync.timer'])

    def test_candidate_verification_record_is_bound_to_candidate_identity(self):
        candidate = {
            'snapshot': 'actual-consistent-1',
            'image': f'{staging.IMAGE}{"a" * 64}',
            'generation': 'actual-consistent-1-aaaaaaaaaaaa',
            'budget_count': 1,
            'inventory': {'server-files/account.sqlite': [1, 'fixture']},
            'manifest': {'files': {'server-files/account.sqlite': [1, 'source']}},
        }
        receipt = staging.verification_receipt(candidate)

        self.assertEqual(receipt['snapshot'], candidate['snapshot'])
        self.assertEqual(receipt['image'], candidate['image'])
        self.assertIn('candidate_id', receipt)
        self.assertNotEqual(
            receipt['candidate_id'],
            staging.verification_receipt({**candidate, 'budget_count': 2})['candidate_id'],
        )

    def test_verify_invalidates_receipt_before_authorized_check(self):
        candidate = {
            'snapshot': 'actual-consistent-1',
            'image': f'{staging.IMAGE}{"a" * 64}',
            'generation': 'actual-consistent-1-aaaaaaaaaaaa',
            'budget_count': 1,
            'inventory': {},
            'manifest': {'files': {}},
        }
        receipt = self.tmp.name + '/verified-candidate.json'
        Path(receipt).write_text(json.dumps(staging.verification_receipt(candidate)))
        verifier = self.root / 'verify-encrypted-budget'
        verifier.write_text('fixture')
        verifier.chmod(0o700)
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'candidate_state', return_value=candidate), \
                mock.patch.object(staging, 'run', side_effect=RuntimeError('rejected')):
            with self.assertRaisesRegex(RuntimeError, 'rejected'):
                staging.verify_candidate()
        self.assertFalse(Path(receipt).exists())

    def test_recover_refuses_unpinned_production_replacement(self):
        before = {
            'Id': 'original',
            'Image': 'original-image',
            'HostConfig': {'Binds': [f'{staging.SOURCE}:/data:rw']},
            'State': {'Running': False},
        }
        replacement = {**before, 'Id': 'replacement'}
        with mock.patch.object(staging, 'prod', return_value=replacement), \
                mock.patch.object(staging, 'docker') as docker:
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                staging.recover(before)
        docker.assert_not_called()

    def test_recover_uses_durable_original_identity(self):
        before = {
            'Id': 'original',
            'Image': 'original-image',
            'HostConfig': {'Binds': [f'{staging.SOURCE}:/data:rw']},
            'State': {'Running': False},
        }
        running = {**before, 'State': {'Running': True}}
        (self.root / 'pending-prod.json').write_text(json.dumps({'Id': before['Id'], 'Image': before['Image']}))
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'prod', side_effect=[before, running]), \
                mock.patch.object(staging, 'docker') as docker:
            staging.recover()
        docker.assert_called_once_with('start', staging.PROD, timeout=staging.RECOVERY_SECONDS)
        self.assertFalse((self.root / 'pending-prod.json').exists())

    def test_tailnet_requires_single_bound_proxy_and_no_funnel(self):
        host = 'staging-fixture.tailnet.ts.net'
        (self.root / 'tailnet-authorized.json').write_text(json.dumps({'host': host, 'funnel': False}))
        serve = json.dumps({
            'Web': {f'{host}:443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:15008'}}}},
            'AllowFunnel': {f'{host}:443': True},
        })
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'run', return_value=serve):
            with self.assertRaisesRegex(ValueError, 'Funnel'):
                staging.assert_tailnet_authorization()

    def test_sync_image_uses_active_snapshot_without_snapshotting_production(self):
        image = f'{staging.IMAGE}{"b" * 64}'
        active = {'snapshot': 'actual-consistent-1', 'image': f'{staging.IMAGE}{"a" * 64}'}
        (self.root / 'active.json').write_text(json.dumps(active))
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'snapshot') as snapshot, \
                mock.patch.object(staging, 'resolve_master_image', return_value=image), \
                mock.patch.object(staging, 'restore') as restore, \
                mock.patch.object(staging, 'verify_candidate'), \
                mock.patch.object(staging, 'promote'):
            staging.sync_image()
        snapshot.assert_not_called()
        restore.assert_called_once_with(staging.BACKUPS / active['snapshot'], image)

    def test_cleanup_removes_expired_spool_and_unreferenced_generation(self):
        backups = self.root / 'backups'
        backups.mkdir()
        stale_generation = self.root / 'generations' / 'stale'
        stale_spool = self.root / 'spool' / 'stale'
        for path in (stale_generation, stale_spool):
            path.mkdir(parents=True)
            os.utime(path, (1, 1))
        with mock.patch.object(staging, 'ROOT', self.root):
            staging.cleanup_snapshots(backups, now=15 * 86400)
        self.assertFalse(stale_generation.exists())
        self.assertFalse(stale_spool.exists())

    def test_freshness_alerts_after_failed_refresh_despite_recent_success(self):
        (self.root / 'last-success.json').write_text(json.dumps({'timestamp': time.time()}))
        (self.root / 'stale.json').write_text(json.dumps({'timestamp': time.time(), 'reason': 'fixture'}))
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'alert') as alert:
            with self.assertRaisesRegex(RuntimeError, 'staging stale'):
                staging.freshness()
        alert.assert_called_once()

    def test_promotion_restores_previous_container_on_state_commit_failure(self):
        candidate = {
            'snapshot': 'actual-consistent-next',
            'image': f'{staging.IMAGE}{"a" * 64}',
            'generation': 'actual-consistent-next-aaaaaaaaaaaa',
            'budget_count': 1,
            'inventory': {},
            'manifest': {'files': {}},
        }
        previous = {**candidate, 'snapshot': 'actual-consistent-prior', 'generation': 'actual-consistent-prior-aaaaaaaaaaaa'}
        (self.root / 'active.json').write_text(json.dumps(previous))
        (self.root / 'verified-candidate.json').write_text(json.dumps(staging.verification_receipt(candidate)))

        def fail_active(path, value):
            if path.name == 'active.json':
                raise OSError('fixture metadata failure')

        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'candidate_state', return_value=candidate), \
                mock.patch.object(staging, 'assert_tailnet_authorization'), \
                mock.patch.object(staging, 'remove_container'), \
                mock.patch.object(staging, 'replace_staging') as replace, \
                mock.patch.object(staging, 'write_json', side_effect=fail_active):
            with self.assertRaisesRegex(OSError, 'fixture metadata failure'):
                staging.promote()
        self.assertEqual(replace.call_args_list, [mock.call(candidate), mock.call(previous)])
        self.assertEqual(json.loads((self.root / 'active.json').read_text()), previous)

    def test_rollback_probes_previous_generation_before_replacing_active(self):
        active = {
            'snapshot': 'actual-consistent-current',
            'image': f'{staging.IMAGE}{"a" * 64}',
            'generation': 'actual-consistent-current-aaaaaaaaaaaa',
            'budget_count': 1,
            'inventory': {},
            'manifest': {'files': {}},
            'data': str(self.root / 'generations/current'),
        }
        previous = {**active, 'snapshot': 'actual-consistent-prior', 'generation': 'actual-consistent-prior-aaaaaaaaaaaa',
                    'data': str(self.root / 'generations/prior')}
        Path(previous['data']).mkdir(parents=True)
        (self.root / 'active.json').write_text(json.dumps(active))
        (self.root / 'previous-active.json').write_text(json.dumps(previous))
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'remove_container') as remove, \
                mock.patch.object(staging, 'create_container') as create, \
                mock.patch.object(staging, 'replace_staging'):
            staging.rollback()
        create.assert_called_once_with(staging.CANDIDATE, Path(previous['data']), previous['image'], staging.CANDIDATE_PORT)
        self.assertEqual(remove.call_args_list[:2], [mock.call(staging.CANDIDATE), mock.call(staging.CANDIDATE)])

    def test_sanitize_rejects_nested_inherited_configuration(self):
        inherited = self.root / 'server-files/.env'
        inherited.write_text('SYNTHETIC_ONLY=1')
        with self.assertRaisesRegex(ValueError, 'inherited server configuration'):
            staging.sanitize(self.root, '$argon2id$fixture')


if __name__ == '__main__':
    unittest.main()
