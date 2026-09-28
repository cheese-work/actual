"""Offline staging checks; run on X99 with python3 -m unittest discover -s ops."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
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

    def network_fixture(self):
        network = {
            'Internal': True,
            'Driver': 'bridge',
            'Options': {
                'com.docker.network.bridge.enable_ip_masquerade': 'false',
                'com.docker.network.bridge.name': 'act-stg0',
            },
            'IPAM': {'Config': [{'Subnet': '172.25.0.0/24', 'Gateway': '172.25.0.1'}]},
        }
        production = {'NetworkSettings': {'Networks': {'production': {'IPAddress': '172.20.0.2'}}}}
        policies = {
            'INPUT': '\n'.join((
                '-P INPUT DROP',
                '-A INPUT -i lo -j ACCEPT',
                '-A INPUT -i act-stg0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
                '-A INPUT -i act-stg0 -j ACTUAL_STAGING_INPUT',
            )),
            'DOCKER-USER': '\n'.join((
                '-N DOCKER-USER',
                '-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
                '-A DOCKER-USER -i act-stg0 -j ACTUAL_STAGING_FORWARD',
            )),
            'FORWARD': '\n'.join((
                '-P FORWARD DROP',
                '-A FORWARD -i act-stg0 -j ACTUAL_STAGING_FORWARD',
                '-A FORWARD -j ts-forward',
                '-A FORWARD -j DOCKER-USER',
            )),
            'ACTUAL_STAGING_INPUT': '\n'.join((
                '-N ACTUAL_STAGING_INPUT',
                '-A ACTUAL_STAGING_INPUT -s 172.25.0.0/24 -d 172.25.0.1/32 -j DROP',
            )),
            'ACTUAL_STAGING_FORWARD': '\n'.join((
                '-N ACTUAL_STAGING_FORWARD',
                '-A ACTUAL_STAGING_FORWARD -s 172.25.0.0/24 -d 172.20.0.2/32 -j DROP',
            )),
        }
        return network, production, policies

    def assert_network_fixture(self, network, production, policies):
        def firewall(*command, **kwargs):
            if command[:2] == ('iptables', '-S'):
                return policies[command[2]]
            return ''

        with mock.patch.object(staging, 'docker', return_value=json.dumps([network])), \
                mock.patch.object(staging, 'prod', return_value=production), \
                mock.patch.object(staging, 'run', side_effect=firewall):
            staging.assert_network_isolation()

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
        self.assertFalse(partial.exists())

    def test_systemd_units_keep_boot_recovery_and_refresh_separate(self):
        units = staging.systemd_units(Path('/srv/actual/ops/actual-staging.py'))

        self.assertIn('actual-prod-watchdog.service', units)
        self.assertIn('ExecStart=/usr/bin/python3 /srv/actual/ops/actual-staging.py recover', units['actual-prod-watchdog.service'])
        self.assertIn('Restart=on-failure', units['actual-prod-watchdog.service'])
        self.assertIn('EnvironmentFile=%h/.config/actual-staging/alert.env', units['actual-staging-refresh.service'])
        self.assertIn('OnCalendar=*-*-* 03:45:00', units['actual-staging-refresh.timer'])
        self.assertIn('Persistent=true', units['actual-staging-freshness.timer'])
        self.assertIn('OnUnitInactiveSec=5min', units['actual-staging-image-sync.timer'])

    def test_watchdog_uses_precise_twenty_second_timer(self):
        with mock.patch.object(staging, 'run') as run:
            staging.schedule_watchdog('fixture')
        self.assertIn('--on-active=20s', run.call_args.args)
        self.assertIn('--timer-property=AccuracySec=1us', run.call_args.args)
        self.assertEqual(run.call_args.args[-2:], ('--capture', 'fixture'))

    def test_staging_lock_does_not_contend_with_existing_tar_lock(self):
        shared_lock = self.root / '.actual-maintenance.lock'
        with shared_lock.open('a') as tar_lock:
            fcntl.flock(tar_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(staging, 'ROOT', self.root):
                self.assertEqual(staging.locked(lambda: 'captured'), 'captured')
        self.assertTrue((self.root / '.actual-staging.lock').is_file())

    def test_remaining_timeout_never_extends_recovery_deadline(self):
        with mock.patch.object(staging.time, 'monotonic', return_value=99.9):
            self.assertAlmostEqual(staging.remaining_timeout(100, 10), 0.1)

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

    def test_recover_uses_capture_specific_durable_identity(self):
        before = {
            'Id': 'original',
            'Image': 'original-image',
            'HostConfig': {'Binds': [f'{staging.SOURCE}:/data:rw']},
            'State': {'Running': False},
        }
        running = {**before, 'State': {'Running': True}}
        (self.root / 'pending-prod-1.json').write_text(json.dumps({
            'Id': before['Id'], 'Image': before['Image'], 'state': 'stopped',
        }))
        (self.root / 'pending-prod-1.json').chmod(0o600)
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'prod', side_effect=[before, running]), \
                mock.patch.object(staging, 'docker') as docker:
            staging.recover(capture='1')
        docker.assert_called_once()
        self.assertEqual(docker.call_args.args, ('start', staging.PROD))
        self.assertLessEqual(docker.call_args.kwargs['timeout'], staging.RECOVERY_SECONDS)
        self.assertFalse((self.root / 'pending-prod-1.json').exists())

    def test_old_watchdog_cannot_consume_new_capture_record(self):
        before = {
            'Id': 'original',
            'Image': 'original-image',
            'HostConfig': {'Binds': [f'{staging.SOURCE}:/data:rw']},
            'State': {'Running': True},
        }
        (self.root / 'pending-prod-2.json').write_text(json.dumps({
            'Id': before['Id'], 'Image': before['Image'], 'state': 'stopping',
        }))
        (self.root / 'pending-prod-2.json').chmod(0o600)
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'prod', return_value=before), \
                mock.patch.object(staging, 'docker') as docker:
            staging.recover(capture='1')
        docker.assert_not_called()
        self.assertTrue((self.root / 'pending-prod-2.json').exists())

    def test_running_capture_record_is_not_cleared_by_watchdog(self):
        before = {
            'Id': 'original',
            'Image': 'original-image',
            'HostConfig': {'Binds': [f'{staging.SOURCE}:/data:rw']},
            'State': {'Running': True},
        }
        (self.root / 'pending-prod-1.json').write_text(json.dumps({
            'Id': before['Id'], 'Image': before['Image'], 'state': 'stopping',
        }))
        (self.root / 'pending-prod-1.json').chmod(0o600)
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'prod', return_value=before), \
                mock.patch.object(staging, 'docker') as docker:
            staging.recover(capture='1')
        docker.assert_not_called()
        self.assertTrue((self.root / 'pending-prod-1.json').exists())

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

    def test_staging_inventory_allows_session_but_not_budget_mutation(self):
        candidate_data = self.root / 'generations' / 'actual-consistent-fixture-aaaaaaaaaaaa'
        candidate_data.mkdir(parents=True)
        shutil.copytree(self.root / 'server-files', candidate_data / 'server-files')
        shutil.copytree(self.root / 'user-files', candidate_data / 'user-files')
        with sqlite3.connect(candidate_data / 'server-files/account.sqlite') as database:
            database.execute("DELETE FROM sessions")
        candidate = {
            'snapshot': 'actual-consistent-fixture',
            'image': f'{staging.IMAGE}{"a" * 64}',
            'generation': candidate_data.name,
            'budget_count': 1,
            'data': str(candidate_data),
            'inventory': staging.staging_inventory(candidate_data),
            'manifest': {'files': {}},
        }
        (self.root / 'candidate.json').write_text(json.dumps(candidate))
        with mock.patch.object(staging, 'ROOT', self.root):
            with sqlite3.connect(candidate_data / 'server-files/account.sqlite') as database:
                database.execute("INSERT INTO sessions VALUES ('session', 'owner', 'password')")
            self.assertEqual(staging.candidate_state(), candidate)
            with sqlite3.connect(candidate_data / 'server-files/account.sqlite') as database:
                database.execute("INSERT INTO files VALUES ('mutated-budget', 0)")
            with self.assertRaisesRegex(ValueError, 'candidate data identity changed'):
                staging.candidate_state()

    def test_account_fingerprint_allows_session_sequence_changes_only(self):
        account = self.root / 'sequence.sqlite'
        with sqlite3.connect(account) as database:
            database.executescript('''
                CREATE TABLE files(id TEXT, deleted INTEGER);
                INSERT INTO files VALUES ('fixture', 0);
                CREATE TABLE sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT);
            ''')
        expected = staging.account_fingerprint(account)
        with sqlite3.connect(account) as database:
            database.execute("INSERT INTO sessions(token) VALUES ('session')")
        self.assertEqual(staging.account_fingerprint(account), expected)
        with sqlite3.connect(account) as database:
            database.execute("INSERT INTO files VALUES ('mutated-budget', 0)")
        self.assertNotEqual(staging.account_fingerprint(account), expected)

    def test_verifier_session_mutation_can_promote_quiesced_candidate(self):
        candidate_data = self.root / 'generations' / 'actual-consistent-fixture-aaaaaaaaaaaa'
        candidate_data.mkdir(parents=True)
        account = candidate_data / 'server-files' / 'account.sqlite'
        account.parent.mkdir()
        with sqlite3.connect(account) as database:
            database.executescript('''
                CREATE TABLE files(id TEXT, deleted INTEGER);
                INSERT INTO files VALUES ('fixture', 0);
                CREATE TABLE sessions(token TEXT, user_id TEXT, auth_method TEXT);
            ''')
        candidate = {
            'snapshot': 'actual-consistent-fixture',
            'image': f'{staging.IMAGE}{"a" * 64}',
            'generation': candidate_data.name,
            'budget_count': 1,
            'data': str(candidate_data),
            'inventory': staging.staging_inventory(candidate_data),
            'manifest': {'files': {}},
        }
        (self.root / 'candidate.json').write_text(json.dumps(candidate))
        verifier = self.root / 'verify-encrypted-budget'
        verifier.write_text('fixture')
        verifier.chmod(0o700)

        def authorized_login(*command, **kwargs):
            with sqlite3.connect(account) as database:
                database.execute("INSERT INTO sessions VALUES ('session', 'owner', 'password')")
            return ''

        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'run', side_effect=authorized_login), \
                mock.patch.object(staging, 'assert_tailnet_authorization'), \
                mock.patch.object(staging, 'remove_container'), \
                mock.patch.object(staging, 'replace_staging'):
            self.assertEqual(staging.verify_candidate()['candidate_id'], staging.verification_receipt(candidate)['candidate_id'])
            self.assertEqual(staging.promote(), candidate)

    def test_network_isolation_requires_ordered_input_and_forwarding_denies(self):
        self.assert_network_fixture(*self.network_fixture())

    def test_network_isolation_rejects_new_connection_accept_before_input_hook(self):
        network, production, policies = self.network_fixture()
        policies['INPUT'] = '\n'.join((
            '-P INPUT DROP',
            '-A INPUT -i act-stg0 -j ACCEPT',
            '-A INPUT -i act-stg0 -j ACTUAL_STAGING_INPUT',
        ))
        with self.assertRaisesRegex(ValueError, 'INPUT isolation hook is shadowed'):
            self.assert_network_fixture(network, production, policies)

    def test_network_isolation_requires_effective_forward_hook(self):
        network, production, policies = self.network_fixture()
        policies['FORWARD'] = '\n'.join((
            '-P FORWARD DROP',
            '-A FORWARD -j ts-forward',
            '-A FORWARD -j DOCKER-USER',
        ))
        with self.assertRaisesRegex(ValueError, 'missing FORWARD isolation hook'):
            self.assert_network_fixture(network, production, policies)

    def test_network_isolation_rejects_forward_hook_after_tailscale_bypass(self):
        network, production, policies = self.network_fixture()
        policies['FORWARD'] = '\n'.join((
            '-P FORWARD DROP',
            '-A FORWARD -j ts-forward',
            '-A FORWARD -i act-stg0 -j ACTUAL_STAGING_FORWARD',
            '-A FORWARD -j DOCKER-USER',
        ))
        with self.assertRaisesRegex(ValueError, 'FORWARD isolation hook is shadowed'):
            self.assert_network_fixture(network, production, policies)

    def test_network_isolation_rejects_goto_before_input_hook(self):
        network, production, policies = self.network_fixture()
        policies['INPUT'] = '\n'.join((
            '-P INPUT DROP',
            '-A INPUT -i act-stg0 -g STAGING_BYPASS',
            '-A INPUT -i act-stg0 -j ACTUAL_STAGING_INPUT',
        ))
        with self.assertRaisesRegex(ValueError, 'unsupported firewall transfer'):
            self.assert_network_fixture(network, production, policies)

    def test_network_isolation_rejects_narrow_required_rules(self):
        narrowed = {
            'INPUT': '-A INPUT -i act-stg0 -p tcp -m tcp --dport 443 -j ACTUAL_STAGING_INPUT',
            'DOCKER-USER': '-A DOCKER-USER -i act-stg0 -s 172.25.0.2 -j ACTUAL_STAGING_FORWARD',
            'ACTUAL_STAGING_INPUT': (
                '-A ACTUAL_STAGING_INPUT -s 172.25.0.0/24 -d 172.25.0.1/32 '
                '-m conntrack --ctstate ESTABLISHED,RELATED -j DROP'
            ),
            'ACTUAL_STAGING_FORWARD': (
                '-A ACTUAL_STAGING_FORWARD -s 172.25.0.0/24 -d 172.20.0.2/32 '
                '-p tcp -m tcp --dport 443 -j DROP'
            ),
        }
        for chain, rule in narrowed.items():
            with self.subTest(chain=chain):
                network, production, policies = self.network_fixture()
                policies[chain] = rule
                with self.assertRaisesRegex(ValueError, 'missing'):
                    self.assert_network_fixture(network, production, policies)

    def test_network_isolation_rejects_wildcard_interface_transfers(self):
        for interface in ('act-st+', 'act-+'):
            for transfer in ('-j ACCEPT', '-g STAGING_BYPASS'):
                with self.subTest(interface=interface, transfer=transfer):
                    network, production, policies = self.network_fixture()
                    policies['INPUT'] = '\n'.join((
                        '-P INPUT DROP',
                        f'-A INPUT -i {interface} {transfer}',
                        '-A INPUT -i act-stg0 -j ACTUAL_STAGING_INPUT',
                    ))
                    with self.assertRaises(ValueError):
                        self.assert_network_fixture(network, production, policies)

    def test_snapshot_cleans_failed_capture_spool(self):
        before = {
            'Id': 'original',
            'Image': 'image',
            'HostConfig': {'Binds': [f'{staging.SOURCE}:/data:rw']},
            'State': {'Running': True},
        }

        def failed_copy(source, destination, deadline):
            destination.mkdir()
            (destination / 'financial-fixture').write_text('synthetic-only')
            raise subprocess.TimeoutExpired(['cp'], 1)

        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'BACKUPS', self.root / 'backups'), \
                mock.patch.object(staging, 'assert_prod_identity', return_value=before), \
                mock.patch.object(staging, 'schedule_watchdog'), \
                mock.patch.object(staging, 'graceful_stop'), \
                mock.patch.object(staging, 'audit', return_value={'fixture': [1, 'hash']}), \
                mock.patch.object(staging.shutil, 'disk_usage', return_value=mock.Mock(free=10**12, total=10**12)), \
                mock.patch.object(staging, 'bounded_copy', side_effect=failed_copy), \
                mock.patch.object(staging, 'recover') as recover:
            with self.assertRaises(subprocess.TimeoutExpired):
                staging.snapshot()
        recover.assert_called_once_with(capture=mock.ANY, deadline=mock.ANY, complete=True)
        self.assertFalse(list((self.root / 'spool').rglob('financial-fixture')))

    def test_quiesced_snapshot_preserves_wal_multidatabase_tree(self):
        source = self.root / 'source'
        shutil.copytree(self.root / 'server-files', source / 'server-files')
        shutil.copytree(self.root / 'user-files', source / 'user-files')
        readers = []
        for path in (
                source / 'server-files/account.sqlite',
                source / 'user-files/group-fixture.sqlite',
        ):
            writer = sqlite3.connect(path)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.commit()
            reader = sqlite3.connect(path)
            reader.execute('SELECT * FROM sqlite_master').fetchall()
            readers.append((writer, reader))
        readers[0][0].execute("INSERT INTO sessions VALUES ('wal', 'owner', 'password')")
        readers[1][0].execute('INSERT INTO messages_binary VALUES (?)', (b'wal',))
        for writer, _ in readers:
            writer.commit()
        for path in (
                source / 'server-files/account.sqlite',
                source / 'user-files/group-fixture.sqlite',
        ):
            self.assertTrue(path.with_name(f'{path.name}-wal').is_file())
        helper_root = self.root / 'helper'
        before = {
            'Id': 'original',
            'Image': 'image',
            'HostConfig': {'Binds': [f'{source}:/data:rw']},
            'State': {'Running': True},
        }
        try:
            with mock.patch.object(staging, 'SOURCE', source), \
                    mock.patch.object(staging, 'ROOT', helper_root), \
                    mock.patch.object(staging, 'BACKUPS', helper_root / 'backups'), \
                    mock.patch.object(staging, 'assert_prod_identity', return_value=before), \
                    mock.patch.object(staging, 'schedule_watchdog'), \
                    mock.patch.object(staging, 'graceful_stop'), \
                    mock.patch.object(staging, 'recover'), \
                    mock.patch.object(staging, 'snapshot_auth_key', return_value=b'k' * 32), \
                    mock.patch.object(staging.shutil, 'disk_usage', return_value=mock.Mock(free=10**12, total=10**12)):
                snapshot = staging.snapshot()
        finally:
            for writer, reader in readers:
                reader.close()
                writer.close()
        manifest = json.loads((snapshot / 'manifest.json').read_text())
        self.assertIn('server-files/account.sqlite', manifest['files'])
        self.assertIn('server-files/account.sqlite-wal', manifest['files'])
        self.assertNotIn('server-files/account.sqlite-shm', manifest['files'])
        self.assertIn('user-files/group-fixture.sqlite', manifest['files'])
        self.assertIn('user-files/group-fixture.sqlite-wal', manifest['files'])
        self.assertNotIn('user-files/group-fixture.sqlite-shm', manifest['files'])
        self.assertFalse((snapshot / 'data/server-files/account.sqlite-shm').exists())
        self.assertFalse((snapshot / 'data/user-files/group-fixture.sqlite-shm').exists())
        self.assertEqual(staging.budget_count(snapshot / 'data'), 1)

    def test_snapshot_rejects_multidatabase_mutation_after_quiescence(self):
        source = self.root / 'source'
        shutil.copytree(self.root / 'server-files', source / 'server-files')
        shutil.copytree(self.root / 'user-files', source / 'user-files')
        helper_root = self.root / 'helper'
        before = {
            'Id': 'original',
            'Image': 'image',
            'HostConfig': {'Binds': [f'{source}:/data:rw']},
            'State': {'Running': True},
        }

        def write_after_audit(source_path, destination, deadline):
            with sqlite3.connect(source / 'user-files/group-fixture.sqlite') as database:
                database.execute('INSERT INTO messages_binary VALUES (?)', (b'late-write',))
            shutil.copytree(source_path, destination)

        with mock.patch.object(staging, 'SOURCE', source), \
                mock.patch.object(staging, 'ROOT', helper_root), \
                mock.patch.object(staging, 'BACKUPS', helper_root / 'backups'), \
                mock.patch.object(staging, 'assert_prod_identity', return_value=before), \
                mock.patch.object(staging, 'schedule_watchdog'), \
                mock.patch.object(staging, 'graceful_stop'), \
                mock.patch.object(staging, 'recover'), \
                mock.patch.object(staging.shutil, 'disk_usage', return_value=mock.Mock(free=10**12, total=10**12)), \
                mock.patch.object(staging, 'bounded_copy', side_effect=write_after_audit):
            with self.assertRaisesRegex(RuntimeError, 'spooled snapshot checksum mismatch'):
                staging.snapshot()

    def test_snapshot_recovers_after_cancellation(self):
        before = {
            'Id': 'original',
            'Image': 'image',
            'HostConfig': {'Binds': [f'{staging.SOURCE}:/data:rw']},
            'State': {'Running': True},
        }
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'BACKUPS', self.root / 'backups'), \
                mock.patch.object(staging, 'assert_prod_identity', return_value=before), \
                mock.patch.object(staging, 'schedule_watchdog'), \
                mock.patch.object(staging, 'graceful_stop'), \
                mock.patch.object(staging, 'audit', return_value={'fixture': [1, 'hash']}), \
                mock.patch.object(staging.shutil, 'disk_usage', return_value=mock.Mock(free=10**12, total=10**12)), \
                mock.patch.object(staging, 'bounded_copy', side_effect=KeyboardInterrupt), \
                mock.patch.object(staging, 'recover') as recover:
            with self.assertRaises(KeyboardInterrupt):
                staging.snapshot()
        recover.assert_called_once_with(capture=mock.ANY, deadline=mock.ANY, complete=True)

    def test_approved_snapshot_rejects_tampered_multidatabase_archive(self):
        backups = self.root / 'backups'
        snapshot = backups / 'actual-consistent-1'
        shutil.copytree(self.root / 'server-files', snapshot / 'data/server-files')
        shutil.copytree(self.root / 'user-files', snapshot / 'data/user-files')
        manifest = {
            'files': staging.audit(snapshot / 'data'),
            'budget_count': staging.budget_count(snapshot / 'data'),
        }
        (snapshot / 'manifest.json').write_text(json.dumps(manifest))
        (self.root / 'snapshot-auth.key').write_bytes(b'k' * 32)
        (self.root / 'snapshot-auth.key').chmod(0o600)
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'BACKUPS', backups):
            staging.sign_snapshot(snapshot.name, manifest)
            with sqlite3.connect(snapshot / 'data/user-files/group-fixture.sqlite') as database:
                database.execute('INSERT INTO messages_binary VALUES (?)', (b'tampered',))
            with self.assertRaisesRegex(ValueError, 'archive checksum mismatch'):
                staging.approved_snapshot(snapshot)

    def test_approved_snapshot_rejects_rewritten_manifest(self):
        backups = self.root / 'backups'
        snapshot = backups / 'actual-consistent-1'
        shutil.copytree(self.root / 'server-files', snapshot / 'data/server-files')
        shutil.copytree(self.root / 'user-files', snapshot / 'data/user-files')
        manifest = {
            'files': staging.audit(snapshot / 'data'),
            'budget_count': staging.budget_count(snapshot / 'data'),
        }
        (snapshot / 'manifest.json').write_text(json.dumps(manifest))
        (self.root / 'snapshot-auth.key').write_bytes(b'k' * 32)
        (self.root / 'snapshot-auth.key').chmod(0o600)
        with mock.patch.object(staging, 'ROOT', self.root), \
                mock.patch.object(staging, 'BACKUPS', backups):
            staging.sign_snapshot(snapshot.name, manifest)
            with sqlite3.connect(snapshot / 'data/user-files/group-fixture.sqlite') as database:
                database.execute('INSERT INTO messages_binary VALUES (?)', (b'tampered',))
            rewritten = {
                'files': staging.audit(snapshot / 'data'),
                'budget_count': staging.budget_count(snapshot / 'data'),
            }
            (snapshot / 'manifest.json').write_text(json.dumps(rewritten))
            with self.assertRaisesRegex(ValueError, 'snapshot manifest signature mismatch'):
                staging.approved_snapshot(snapshot)


if __name__ == '__main__':
    unittest.main()
