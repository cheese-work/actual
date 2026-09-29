#!/usr/bin/env python3
"""Fail-closed C00 Actual staging refresh helper.

Installed and enabled only during the approved C00 rehearsal. It never builds
images and never uses production credentials or integrations.
"""
import argparse
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

PROD = 'actual-budget'
STAGING = 'actual-staging'
CANDIDATE = 'actual-staging-candidate'
SOURCE = Path('/home/congvc/projects/oss/actual-budget/data')
BACKUPS = Path('/home/congvc/projects/oss/actual-budget/backups')
ROOT = Path('/home/congvc/projects/oss/actual-staging')
IMAGE = 'ghcr.io/cheese-work/actual-server@sha256:'
MASTER = 'ghcr.io/cheese-work/actual-server:master'
DIGEST = re.compile(r'^ghcr.io/cheese-work/actual-server@sha256:[0-9a-f]{64}$')
ACTIVE_PORT = 15008
CANDIDATE_PORT = 15009
STAGING_SERVE_PORT = 15018
PRODUCTION_SERVE_PROXY = 'http://127.0.0.1:8765'
CAPTURE_SECONDS = 20
RECOVERY_SECONDS = 10
INTERRUPTION_SECONDS = CAPTURE_SECONDS + RECOVERY_SECONDS
ALERT_ENV = Path.home() / '.config/actual-staging/alert.env'
ALERT_ISSUE = 'CHE-828'
# Root comment on CHE-828; Multica rejects top-level comments from comment-triggered tasks, so every alert replies here.
ALERT_PARENT = '01a0eb2a-01d5-7502-b4e6-af49fc538366'
ALERT_ASSIGNEE = '[@c00-hermes-devops](mention://agent/b2b52f93-32e6-4caf-80ad-1b48cf60b821)'
ALERT_MESSAGES = {
    'alert delivery test',
    'production remains down after SIGTERM',
    'production restart failed',
    'snapshot refresh stale over 26 hours',
    'staging action failed; prior state preserved',
}
MANIFEST_BYTES = 8 * 1024**2
COPY_BLOCK_BYTES = 1024**2


def run(*cmd, timeout=60):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def docker(*cmd, timeout=60):
    return run('docker', *cmd, timeout=timeout)


def remaining_timeout(deadline, maximum=60):
    if deadline is None:
        return maximum
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('production recovery deadline exceeded')
    return min(maximum, remaining)


def prod(timeout=60):
    return json.loads(docker('inspect', PROD, timeout=timeout))[0]


def containers():
    return set(docker('ps', '-a', '--format', '{{.Names}}').splitlines())


def ensure_dir(path):
    if path.is_symlink():
        raise ValueError(f'unsafe directory: {path}')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def ensure_snapshot_store():
    if BACKUPS.is_symlink() or (BACKUPS.exists() and not BACKUPS.is_dir()):
        raise ValueError('unsafe snapshot store')
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    return BACKUPS


def write_json(path, value):
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'))
    temporary = path.with_suffix(f'{path.suffix}.partial')
    temporary.write_text(encoded)
    temporary.chmod(0o600)
    temporary.replace(path)


def read_json(path):
    return json.loads(path.read_text())


def reserve_disk(directory, required):
    disk = shutil.disk_usage(directory)
    if disk.free - required < max(5 * 1024**3, disk.total // 5):
        raise RuntimeError('disk reserve insufficient')


def pending_path(capture):
    if not capture.isdecimal():
        raise ValueError('invalid capture identity')
    return ROOT / f'pending-prod-{capture}.json'


def pending_record(capture):
    path = pending_path(capture)
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('pending production recovery record is unsafe')
    return path, read_json(path)


def set_pending_state(capture, state):
    path, record = pending_record(capture)
    record['state'] = state
    write_json(path, record)


def started_at(container):
    return container['State'].get('StartedAt')


def audit(root, deadline=None):
    result = {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('unsafe snapshot root')
    for base, dirs, files in os.walk(root, followlinks=False):
        if deadline is not None and time.monotonic() >= deadline:
            raise RuntimeError('source audit missed production recovery deadline')
        for name in dirs + files:
            path = Path(base, name)
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise ValueError('unsafe file in data tree')
        for name in files:
            path = Path(base, name)
            if name.endswith('.sqlite-shm'):
                continue
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1048576), b''):
                    if deadline is not None and time.monotonic() >= deadline:
                        raise RuntimeError('source audit missed production recovery deadline')
                    digest.update(block)
            if deadline is not None and time.monotonic() >= deadline:
                raise RuntimeError('source audit missed production recovery deadline')
            result[str(path.relative_to(root))] = [path.stat().st_size, digest.hexdigest()]
    return result


def remove_sqlite_shared_memory(root):
    for path in root.rglob('*.sqlite-shm'):
        if path.is_symlink() or not path.is_file():
            raise ValueError('unsafe SQLite shared-memory sidecar')
        path.unlink()


def budget_count(root):
    databases = list(root.rglob('*.sqlite'))
    account = root / 'server-files/account.sqlite'
    if not account.is_file() or not databases:
        raise ValueError('missing SQLite data')
    for path in databases:
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as conn:
            if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('database integrity check failed')
    with sqlite3.connect(f'file:{account}?mode=ro', uri=True) as conn:
        return conn.execute('SELECT count(*) FROM files WHERE deleted = 0').fetchone()[0]


def alert(message):
    target = os.environ.get('ACTUAL_ALERT_TARGET')
    if target != ALERT_ISSUE:
        raise RuntimeError('alert destination must be CHE-828')
    if message not in ALERT_MESSAGES:
        raise ValueError('unsupported staging alert message')
    with tempfile.TemporaryDirectory(prefix='actual-staging-alert-', dir=Path.cwd()) as directory:
        content = Path(directory) / 'comment.md'
        content.write_text(f'CHE-828 staging alert — {message}\n\n{ALERT_ASSIGNEE}\n', encoding='utf-8')
        content.chmod(0o600)
        run(
            'multica', 'issue', 'comment', 'add', target, '--parent', ALERT_PARENT,
            '--content-file', str(content), '--output', 'table', timeout=20,
        )


def alert_configured():
    if ALERT_ENV.is_symlink() or not ALERT_ENV.is_file() or ALERT_ENV.stat().st_mode & 0o077:
        raise ValueError('scheduled alert configuration must be a private regular file')
    targets = [line.partition('=')[2] for line in ALERT_ENV.read_text(encoding='utf-8').splitlines()
               if line.startswith('ACTUAL_ALERT_TARGET=')]
    if targets != [ALERT_ISSUE]:
        raise ValueError('scheduled alert destination must be CHE-828')


def snapshot_auth_key():
    path = ROOT / 'snapshot-auth.key'
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('snapshot authentication key must be a private regular file')
    key = path.read_bytes()
    if len(key) < 32:
        raise ValueError('snapshot authentication key is too short')
    return key


def manifest_files(manifest):
    files = manifest.get('files')
    if not isinstance(files, dict) or not isinstance(manifest.get('budget_count'), int):
        raise ValueError('invalid snapshot manifest')
    result = []
    for name, entry in files.items():
        path = Path(name) if isinstance(name, str) else None
        if (path is None or not name or path.is_absolute()
                or any(part in ('', '.', '..') for part in path.parts)):
            raise ValueError('unsafe path in snapshot manifest')
        if (not isinstance(entry, list) or len(entry) != 2
                or isinstance(entry[0], bool) or not isinstance(entry[0], int) or entry[0] < 0
                or not isinstance(entry[1], str) or not re.fullmatch(r'[0-9a-f]{64}', entry[1])):
            raise ValueError('invalid file in snapshot manifest')
        result.append((name, path, entry[0], entry[1]))
    return sorted(result)


def open_directory(path, parent_fd=None):
    try:
        return os.open(
            path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=parent_fd,
        )
    except OSError as error:
        raise ValueError('unsafe snapshot directory') from error


def read_regular_file(directory_fd, name, maximum):
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    except OSError as error:
        raise ValueError('unsafe snapshot file') from error
    try:
        details = os.fstat(file_fd)
        if not stat.S_ISREG(details.st_mode) or details.st_size > maximum:
            raise ValueError('unsafe snapshot file')
        remaining = details.st_size
        content = bytearray()
        while remaining:
            block = os.read(file_fd, min(COPY_BLOCK_BYTES, remaining))
            if not block:
                raise ValueError('snapshot file changed while reading')
            content.extend(block)
            remaining -= len(block)
        if os.read(file_fd, 1):
            raise ValueError('snapshot file changed while reading')
        return bytes(content)
    finally:
        os.close(file_fd)


def authenticated_manifest(snapshot_fd, snapshot):
    try:
        manifest = json.loads(read_regular_file(snapshot_fd, 'manifest.json', MANIFEST_BYTES))
    except json.JSONDecodeError as error:
        raise ValueError('invalid snapshot manifest') from error
    manifest_files(manifest)
    verify_snapshot_signature(snapshot.name, manifest)
    return manifest


def open_authenticated_snapshot(snapshot):
    snapshot_fd = open_directory(snapshot)
    try:
        return snapshot_fd, authenticated_manifest(snapshot_fd, snapshot)
    except BaseException:
        os.close(snapshot_fd)
        raise


def manifest_signature(snapshot, manifest):
    payload = snapshot.encode() + b'\0' + json.dumps(
        manifest, sort_keys=True, separators=(',', ':'),
    ).encode()
    return hmac.new(snapshot_auth_key(), payload, hashlib.sha256).hexdigest()


def signature_path(snapshot):
    if not re.fullmatch(r'actual-consistent-[0-9]+', snapshot):
        raise ValueError('invalid snapshot name')
    return ROOT / 'snapshot-signatures' / f'{snapshot}.json'


def sign_snapshot(snapshot, manifest):
    path = signature_path(snapshot)
    ensure_dir(path.parent)
    write_json(
        path,
        {'snapshot': snapshot, 'signature': manifest_signature(snapshot, manifest)},
    )


def verify_snapshot_signature(snapshot, manifest):
    path = signature_path(snapshot)
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('snapshot signature is unsafe or missing')
    signature = read_json(path)
    if signature.get('snapshot') != snapshot or not hmac.compare_digest(
            signature.get('signature', ''), manifest_signature(snapshot, manifest)):
        raise ValueError('snapshot manifest signature mismatch')


def locked(action, name='.actual-staging.lock'):
    ensure_dir(ROOT)
    lock_path = ROOT / name
    if lock_path.is_symlink():
        raise ValueError('unsafe staging lock')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return action()


def recovery_locked(action):
    return locked(action, '.actual-recovery.lock')


def assert_prod_identity(before=None, deadline=None):
    current = prod(timeout=remaining_timeout(deadline, RECOVERY_SECONDS))
    if current['HostConfig']['Binds'] != [f'{SOURCE}:/data:rw']:
        raise RuntimeError('unexpected production mount; refusing restart')
    if before and (current['Id'] != before['Id'] or current['Image'] != before['Image']):
        raise RuntimeError('production container identity changed')
    return current


def recovery_alert(message):
    try:
        alert(message)
    except Exception:
        print('PRODUCTION RECOVERY ALERT FAILED', file=sys.stderr)


def recovered(pending, current):
    if not current['State']['Running']:
        return False
    if pending['state'] == 'armed':
        return True
    return pending.get('started_at') is not None and started_at(current) != pending['started_at']


def recover(before=None, deadline=None, capture=None):
    if before is None and capture is None:
        for path in sorted(ROOT.glob('pending-prod-*.json')):
            recover(capture=path.stem.removeprefix('pending-prod-'))
        return
    pending_path_value = None
    pending = None
    if before is None:
        if not pending_path(capture).exists():
            return
        pending_path_value, before = pending_record(capture)
        pending = before
    deadline = deadline or time.monotonic() + RECOVERY_SECONDS
    while True:
        if time.monotonic() >= deadline:
            if pending and pending['state'] != 'armed':
                recovery_alert('production remains down after SIGTERM')
            raise RuntimeError('production recovery did not observe a new start')
        current = assert_prod_identity(before, deadline)
        if not current['State']['Running']:
            try:
                docker('start', PROD, timeout=remaining_timeout(deadline, RECOVERY_SECONDS))
            except subprocess.CalledProcessError:
                current = assert_prod_identity(before, deadline)
                if not current['State']['Running']:
                    if pending:
                        recovery_alert('production restart failed')
                    raise
            current = assert_prod_identity(before, deadline)
        if not pending or recovered(pending, current):
            if pending:
                pending_path_value.unlink(missing_ok=True)
            return
        time.sleep(0.2)


def schedule_watchdog(stamp):
    run(
        'systemd-run', '--user', '--collect', f'--unit=actual-prod-watchdog-{stamp}',
        '--on-active=20s', '--timer-property=AccuracySec=1us',
        f'--property=EnvironmentFile={ALERT_ENV}', '--property=Restart=on-failure',
        '--property=RestartSec=2s',
        sys.executable, str(Path(__file__).resolve()), 'recover', '--capture', stamp,
        timeout=10,
    )


def graceful_stop(before, deadline, capture=None):
    if capture:
        set_pending_state(capture, 'stopping')
    docker('kill', '--signal', 'SIGTERM', PROD, timeout=remaining_timeout(deadline, RECOVERY_SECONDS))
    while time.monotonic() < deadline:
        if not assert_prod_identity(before, deadline)['State']['Running']:
            if capture:
                set_pending_state(capture, 'stopped')
            return
        time.sleep(0.2)
    raise RuntimeError('production did not stop gracefully before capture deadline')


def bounded_copy(source, destination, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('copy cannot meet production recovery deadline')
    subprocess.run(
        ('cp', '-a', '--', str(source), str(destination)),
        check=True, capture_output=True, text=True, timeout=remaining,
    )


def snapshot():
    return recovery_locked(snapshot_locked)


def snapshot_locked():
    snapshot_auth_key()
    alert_configured()
    before = assert_prod_identity()
    ensure_dir(ROOT / 'spool')
    ensure_snapshot_store()
    stamp = str(time.time_ns())
    copied = ROOT / 'spool' / stamp
    copied.mkdir(mode=0o700)
    write_json(
        pending_path(stamp),
        {'Id': before['Id'], 'Image': before['Image'], 'state': 'armed', 'started_at': started_at(before)},
    )
    schedule_watchdog(stamp)
    started = time.monotonic()
    capture_deadline = started + CAPTURE_SECONDS
    recovery_deadline = started + INTERRUPTION_SECONDS
    try:
        try:
            graceful_stop(before, capture_deadline, stamp)
            files = audit(SOURCE, capture_deadline)
            required = sum(size for size, _ in files.values())
            reserve_disk(ROOT, required)
            bounded_copy(SOURCE, copied / 'data', capture_deadline)
            remove_sqlite_shared_memory(copied / 'data')
        finally:
            recover(capture=stamp, deadline=recovery_deadline)
        if time.monotonic() > recovery_deadline:
            raise RuntimeError('production deadline exceeded')
        copied_files = audit(copied / 'data')
        if copied_files != files:
            raise RuntimeError('spooled snapshot checksum mismatch')
        count = budget_count(copied / 'data')
        remove_sqlite_shared_memory(copied / 'data')
        write_json(
            copied / 'manifest.json',
            {'files': copied_files, 'budget_count': count, 'source_image': before['Image'], 'timestamp': stamp},
        )
        partial = BACKUPS / f'.actual-consistent-{stamp}.partial'
        target = BACKUPS / f'actual-consistent-{stamp}'
        if partial.exists() or target.exists():
            raise RuntimeError('snapshot name collision')
        try:
            shutil.copytree(copied, partial, symlinks=False)
            if audit(partial / 'data') != copied_files:
                raise RuntimeError('archive checksum mismatch')
            partial.rename(target)
            sign_snapshot(target.name, read_json(target / 'manifest.json'))
        except BaseException:
            shutil.rmtree(partial, ignore_errors=True)
            shutil.rmtree(target, ignore_errors=True)
            raise
        return target
    finally:
        shutil.rmtree(copied, ignore_errors=True)


def sanitize(root, password_hash):
    if not password_hash.startswith('$argon2id$'):
        raise ValueError('staging-specific password hash required')
    reject_inherited_configuration(root)
    with sqlite3.connect(root / 'server-files/account.sqlite') as db:
        tables = {
            'sessions': {'token', 'user_id', 'auth_method'},
            'auth': {'method', 'extra_data', 'active'},
            'secrets': {'name', 'value'},
            'pending_openid_requests': {'state'},
        }
        for table, required in tables.items():
            if not required <= {row[1] for row in db.execute(f'PRAGMA table_info({table})')}:
                raise ValueError('unsupported auth schema')
        owner_count = db.execute(
            "SELECT count(*) FROM users WHERE user_name = '' AND owner = 1 AND enabled = 1",
        ).fetchone()[0]
        if owner_count != 1:
            raise ValueError('password owner missing or ambiguous')
        db.execute('BEGIN IMMEDIATE')
        for table in ('sessions', 'pending_openid_requests', 'secrets', 'auth'):
            db.execute(f'DELETE FROM {table}')
        db.execute(
            "INSERT INTO auth (method, display_name, extra_data, active) VALUES ('password', 'Password', ?, 1)",
            (password_hash,),
        )
        db.commit()
        for table in ('sessions', 'pending_openid_requests', 'secrets'):
            if db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]:
                raise ValueError('sanitation verification failed')
    return budget_count(root)


def reject_inherited_configuration(root):
    unsafe_names = {'.env', 'config.json', 'config.json5', 'secrets.json'}
    for path in root.rglob('*'):
        if path.is_file() and path.name in unsafe_names:
            raise ValueError(f'inherited server configuration is not permitted: {path.relative_to(root)}')


def staging_password_hash():
    path = ROOT / 'password.hash'
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('staging password hash must be a private regular file')
    return path.read_text().strip()


def probe(port):
    for _ in range(20):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=2) as response:
                if response.status == 200:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('container failed HTTP readiness')


def snapshot_source(path):
    path = path.resolve(strict=True)
    if BACKUPS.resolve() not in path.parents or not path.name.startswith('actual-consistent-'):
        raise ValueError('snapshot outside approved store')
    return path


def approved_manifest(data, manifest):
    manifest_files(manifest)
    if audit(data) != manifest['files']:
        raise ValueError('archive checksum mismatch')
    count = budget_count(data)
    if count != manifest['budget_count']:
        raise ValueError('source snapshot count mismatch')
    reject_inherited_configuration(data)
    return manifest, count


def approved_snapshot(snapshot, data=None, manifest_path=None):
    if data is None:
        snapshot = snapshot_source(snapshot)
        snapshot_fd, manifest = open_authenticated_snapshot(snapshot)
        os.close(snapshot_fd)
        data = snapshot / 'data'
    else:
        manifest = read_json(manifest_path)
        manifest_files(manifest)
        verify_snapshot_signature(snapshot.name, manifest)
    return approved_manifest(data, manifest)


def source_file_names(directory_fd, prefix=()):
    names = set()
    with os.scandir(os.dup(directory_fd)) as entries:
        for entry in entries:
            try:
                details = entry.stat(follow_symlinks=False)
            except OSError as error:
                raise ValueError('unsafe file in snapshot data') from error
            if stat.S_ISLNK(details.st_mode) or not entry.name:
                raise ValueError('unsafe file in snapshot data')
            path = prefix + (entry.name,)
            if stat.S_ISDIR(details.st_mode):
                child_fd = open_directory(entry.name, directory_fd)
                try:
                    names.update(source_file_names(child_fd, path))
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(details.st_mode):
                names.add('/'.join(path))
            else:
                raise ValueError('unsafe file in snapshot data')
    return names


def open_manifest_file(data_fd, path):
    parent_fd = os.dup(data_fd)
    try:
        for name in path.parts[:-1]:
            child_fd = open_directory(name, parent_fd)
            os.close(parent_fd)
            parent_fd = child_fd
        try:
            return os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        except OSError as error:
            raise ValueError('unsafe file in snapshot data') from error
    finally:
        os.close(parent_fd)


def copy_manifest_file(data_fd, candidate_data, path, expected_size, expected_digest):
    source_fd = open_manifest_file(data_fd, path)
    try:
        details = os.fstat(source_fd)
        if not stat.S_ISREG(details.st_mode):
            raise ValueError('unsafe file in snapshot data')
        if details.st_size != expected_size:
            raise ValueError('snapshot file size mismatch')
        destination = candidate_data.joinpath(*path.parts)
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        digest = hashlib.sha256()
        remaining = expected_size
        with os.fdopen(source_fd, 'rb', closefd=False) as source, destination.open('xb') as target:
            while remaining:
                block = source.read(min(COPY_BLOCK_BYTES, remaining))
                if not block:
                    raise ValueError('snapshot file changed while copying')
                target.write(block)
                digest.update(block)
                remaining -= len(block)
            if source.read(1):
                raise ValueError('snapshot file changed while copying')
        destination.chmod(0o600)
        if digest.hexdigest() != expected_digest:
            raise ValueError('archive checksum mismatch')
    finally:
        os.close(source_fd)


def copy_manifest_data(snapshot_fd, manifest, candidate_data):
    files = manifest_files(manifest)
    reserve_disk(candidate_data.parent, sum(size for _, _, size, _ in files))
    data_fd = open_directory('data', snapshot_fd)
    try:
        expected_names = {name for name, _, _, _ in files}
        if source_file_names(data_fd) != expected_names:
            raise ValueError('snapshot tree does not match manifest')
        candidate_data.mkdir(mode=0o700)
        for _, path, size, digest in files:
            copy_manifest_file(data_fd, candidate_data, path, size, digest)
    finally:
        os.close(data_fd)


def assert_network_isolation():
    network = json.loads(docker('network', 'inspect', 'actual-staging-isolated'))[0]
    options = network.get('Options', {})
    config = network.get('IPAM', {}).get('Config', [])
    bridge = options.get('com.docker.network.bridge.name')
    if (not network.get('Internal') or network.get('Driver') != 'bridge'
            or options.get('com.docker.network.bridge.enable_ip_masquerade') != 'false'
            or not bridge or len(config) != 1 or not config[0].get('Subnet') or not config[0].get('Gateway')):
        raise ValueError('staging network lacks required host and production isolation')
    production_ips = {
        settings.get('IPAddress')
        for settings in prod().get('NetworkSettings', {}).get('Networks', {}).values()
        if settings.get('IPAddress')
    }
    if not production_ips:
        raise ValueError('production container has no network identity to deny')
    subnet = config[0]['Subnet']
    assert_firewall_hook('INPUT', bridge, 'ACTUAL_STAGING_INPUT')
    assert_firewall_deny('ACTUAL_STAGING_INPUT', subnet, {config[0]['Gateway']})
    assert_effective_forward_hook(bridge, 'ACTUAL_STAGING_FORWARD')
    assert_firewall_hook('DOCKER-USER', bridge, 'ACTUAL_STAGING_FORWARD')
    assert_firewall_deny('ACTUAL_STAGING_FORWARD', subnet, production_ips)


def firewall_rules(chain):
    prefix = f'-A {chain} '
    return [
        shlex.split(line)
        for line in run('iptables', '-S', chain, timeout=10).splitlines()
        if line.startswith(prefix)
    ]


def assert_firewall_hook(chain, bridge, policy):
    rules = firewall_rules(chain)
    try:
        index = next(
            index for index, rule in enumerate(rules)
            if firewall_is_full_hook(rule, chain, bridge, policy)
        )
    except StopIteration as error:
        raise ValueError(f'missing {chain} isolation hook') from error
    assert_safe_preceding(
        rules[:index],
        lambda rule: firewall_interface_may_match(firewall_value(rule, '-i'), bridge),
        f'{chain} isolation hook',
    )


def assert_effective_forward_hook(bridge, policy):
    rules = firewall_rules('FORWARD')
    try:
        index = next(
            index for index, rule in enumerate(rules)
            if firewall_is_full_hook(rule, 'FORWARD', bridge, policy)
        )
    except StopIteration as error:
        raise ValueError('missing FORWARD isolation hook') from error
    if index:
        raise ValueError('FORWARD isolation hook is shadowed')


def assert_firewall_deny(policy, subnet, destinations):
    rules = firewall_rules(policy)
    for destination in destinations:
        try:
            index = next(
                index for index, rule in enumerate(rules)
                if firewall_is_full_deny(rule, policy, subnet, destination)
            )
        except StopIteration as error:
            raise ValueError(f'missing {policy} deny for {destination}') from error
        assert_safe_preceding(
            rules[:index],
            lambda rule: firewall_may_match(rule, subnet, destination),
            f'{policy} deny for {destination}',
        )


def firewall_is_full_hook(rule, chain, bridge, policy):
    return (
        len(rule) == 6
        and rule[:2] == ['-A', chain]
        and firewall_value(rule, '-i') == bridge
        and firewall_target(rule) == ('jump', policy)
    )


def firewall_is_full_deny(rule, policy, subnet, destination):
    return (
        len(rule) == 8
        and rule[:2] == ['-A', policy]
        and firewall_target(rule) == ('jump', 'DROP')
        and firewall_address_equals(firewall_value(rule, '-s'), subnet)
        and firewall_address_equals(firewall_value(rule, '-d'), destination)
    )


def firewall_value(rule, option):
    indexes = [index for index, value in enumerate(rule) if value == option]
    if len(indexes) != 1:
        return None
    index = indexes[0]
    if index == 0 or index + 1 == len(rule) or rule[index - 1] == '!':
        return None
    return rule[index + 1]


def firewall_target(rule):
    target = firewall_value(rule, '-j')
    if target:
        return 'jump', target
    target = firewall_value(rule, '-g')
    if target:
        return 'goto', target
    return None, None


def firewall_address_equals(actual, expected):
    if actual is None:
        return False
    try:
        return ipaddress.ip_network(actual, strict=False) == ipaddress.ip_network(expected, strict=False)
    except ValueError:
        return False


def firewall_interface_may_match(actual, bridge):
    if actual is None:
        return True
    if actual.endswith('+'):
        return bridge.startswith(actual[:-1])
    return '+' in actual or actual == bridge


def firewall_may_match(rule, subnet, destination):
    return firewall_network_overlaps(firewall_value(rule, '-s'), subnet) and firewall_network_overlaps(
        firewall_value(rule, '-d'), destination,
    )


def firewall_network_overlaps(actual, expected):
    if actual is None:
        return True
    try:
        return ipaddress.ip_network(actual, strict=False).overlaps(ipaddress.ip_network(expected, strict=False))
    except ValueError:
        return True


def firewall_is_reply_allowance(rule):
    target_kind, target = firewall_target(rule)
    states = firewall_value(rule, '--ctstate') or firewall_value(rule, '--state')
    return (
        target_kind == 'jump'
        and target == 'ACCEPT'
        and states is not None
        and set(states.split(',')) <= {'ESTABLISHED', 'RELATED'}
    )


def assert_safe_preceding(rules, applies, description):
    for rule in rules:
        if not applies(rule):
            continue
        target_kind, target = firewall_target(rule)
        if target_kind == 'goto' or target_kind is None:
            raise ValueError(f'unsupported firewall transfer before {description}')
        if target == 'ACCEPT' and not firewall_is_reply_allowance(rule):
            raise ValueError(f'{description} is shadowed')
        if target not in ('ACCEPT', 'DROP', 'REJECT', 'LOG', 'NFLOG'):
            raise ValueError(f'unsupported firewall transfer before {description}')


def create_container(name, data, image, port):
    assert_network_isolation()
    docker(
        'create', '--name', name, '--network', 'actual-staging-isolated', '--read-only',
        '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-p', f'127.0.0.1:{port}:5006',
        '-v', f'{data}:/data:rw', '-e', 'NODE_ENV=production', image,
    )
    docker('start', name)
    probe(port)


def remove_container(name):
    if name in containers():
        state = json.loads(docker('inspect', name))[0]['State']
        if state['Running']:
            docker('kill', '--signal', 'SIGTERM', name, timeout=RECOVERY_SECONDS)
            deadline = time.monotonic() + RECOVERY_SECONDS
            while time.monotonic() < deadline:
                if not json.loads(docker('inspect', name))[0]['State']['Running']:
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError(f'{name} did not stop gracefully')
        docker('rm', name)


def candidate_identity(candidate):
    required = ('snapshot', 'image', 'generation', 'budget_count', 'inventory', 'manifest')
    if any(key not in candidate for key in required):
        raise ValueError('candidate identity is incomplete')
    return {
        key: candidate[key]
        for key in required
    }


def verification_receipt(candidate):
    identity = json.dumps(
        candidate_identity(candidate),
        sort_keys=True, separators=(',', ':'),
    ).encode()
    return {
        'candidate_id': hashlib.sha256(identity).hexdigest(),
        'snapshot': candidate['snapshot'],
        'image': candidate['image'],
        'generation': candidate['generation'],
        'verified_at': int(time.time()),
    }


def account_fingerprint(path):
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as source, sqlite3.connect(':memory:') as database:
        source.backup(database)
        database.execute('DELETE FROM sessions')
        if database.execute(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
        ).fetchone()[0]:
            database.execute("DELETE FROM sqlite_sequence WHERE name = 'sessions'")
        dump = '\n'.join(database.iterdump()).encode()
    return hashlib.sha256(dump).hexdigest()


def staging_inventory(root):
    inventory = audit(root)
    account = root / 'server-files/account.sqlite'
    key = str(account.relative_to(root))
    if key not in inventory:
        raise ValueError('missing account database')
    inventory[key] = ['session-tolerant-sqlite', account_fingerprint(account)]
    return inventory


def restore(snapshot_path, image):
    if not DIGEST.fullmatch(image):
        raise ValueError('only published fork digest allowed')
    path = snapshot_source(snapshot_path)
    snapshot_fd, manifest = open_authenticated_snapshot(path)
    base = ensure_dir(ROOT / 'generations')
    generation = f'{path.name}-{image.rsplit(":", 1)[1][:12]}'
    candidate_data = base / generation
    if candidate_data.exists():
        os.close(snapshot_fd)
        raise RuntimeError('candidate name collision')
    try:
        copy_manifest_data(snapshot_fd, manifest, candidate_data)
        manifest, expected = approved_manifest(candidate_data, manifest)
        if sanitize(candidate_data, staging_password_hash()) != expected:
            raise RuntimeError('restored snapshot count mismatch')
        remove_container(CANDIDATE)
        create_container(CANDIDATE, candidate_data, image, CANDIDATE_PORT)
        candidate = {
            'snapshot': path.name,
            'image': image,
            'generation': generation,
            'budget_count': expected,
            'data': str(candidate_data),
            'inventory': staging_inventory(candidate_data),
            'manifest': manifest,
        }
        write_json(ROOT / 'candidate.json', candidate)
        return candidate
    except BaseException:
        remove_container(CANDIDATE)
        shutil.rmtree(candidate_data, ignore_errors=True)
        raise
    finally:
        os.close(snapshot_fd)


def candidate_state():
    candidate = read_json(ROOT / 'candidate.json')
    data = Path(candidate['data']).resolve(strict=True)
    generations = (ROOT / 'generations').resolve()
    if generations not in data.parents:
        raise ValueError('candidate data outside staging root')
    if not DIGEST.fullmatch(candidate['image']):
        raise ValueError('candidate image is not a pinned digest')
    if candidate.get('generation') != data.name:
        raise ValueError('candidate generation identity changed')
    if candidate.get('inventory') != staging_inventory(data) or candidate.get('budget_count') != budget_count(data):
        raise ValueError('candidate data identity changed')
    candidate_identity(candidate)
    return candidate


def verify_candidate():
    (ROOT / 'verified-candidate.json').unlink(missing_ok=True)
    candidate = candidate_state()
    verifier = ROOT / 'verify-encrypted-budget'
    if verifier.is_symlink() or not verifier.is_file() or verifier.stat().st_mode & 0o077:
        raise ValueError('authorized encrypted-budget verifier must be private and executable')
    if not os.access(verifier, os.X_OK):
        raise ValueError('authorized encrypted-budget verifier is not executable')
    run(
        str(verifier), candidate['snapshot'], candidate['image'], verification_receipt(candidate)['candidate_id'],
        timeout=120,
    )
    candidate = candidate_state()
    receipt = verification_receipt(candidate)
    write_json(ROOT / 'verified-candidate.json', receipt)
    return receipt


def assert_tailnet_authorization():
    authorization = read_json(ROOT / 'tailnet-authorized.json')
    if not authorization.get('host') or authorization.get('funnel') is not False:
        raise ValueError('tailnet ACL authorization missing or permits Funnel')
    host = authorization['host']
    try:
        serve = json.loads(run('tailscale', 'serve', 'status', '--json', timeout=10))
        funnel = json.loads(run('tailscale', 'funnel', 'status', '--json', timeout=10))
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError('unsupported Tailscale Serve or Funnel status') from error
    if not isinstance(serve, dict) or not isinstance(funnel, dict):
        raise ValueError('unsupported Tailscale Serve or Funnel status')
    for status in (serve, funnel):
        foreground = status.get('Foreground', {})
        if not isinstance(foreground, dict) or foreground:
            raise ValueError('foreground Serve sessions are not allowed for staging')
        tcp = status.get('TCP')
        if not isinstance(tcp, dict) or tcp.get('443') != {'HTTPS': True} or \
                tcp.get(str(STAGING_SERVE_PORT)) != {'HTTPS': True}:
            raise ValueError('Tailscale TCP routes do not match approved HTTPS endpoints')
    serve_web = serve.get('Web')
    if not isinstance(serve_web, dict):
        raise ValueError('unsupported Tailscale Serve status')
    expected = {'Handlers': {'/': {'Proxy': f'http://127.0.0.1:{ACTIVE_PORT}'}}}
    if serve_web.get(f'{host}:{STAGING_SERVE_PORT}') != expected:
        raise ValueError('tailnet Serve endpoint does not match approved staging origin')
    original = {'Handlers': {'/': {'Proxy': PRODUCTION_SERVE_PROXY}}}
    if serve_web.get(f'{host}:443') != original:
        raise ValueError('original :443 Serve route changed')
    for status in (serve, funnel):
        allow_funnel = status.get('AllowFunnel', {})
        if not isinstance(allow_funnel, dict) or any(value is not False for value in allow_funnel.values()):
            raise ValueError('Funnel must remain disabled for staging')
    funnel_web = funnel.get('Web')
    if not isinstance(funnel_web, dict):
        raise ValueError('unsupported Tailscale Funnel status')
    if funnel_web and funnel_web != serve_web:
        raise ValueError('Funnel must remain disabled for staging')


def replace_staging(state):
    data = Path(state['data']).resolve(strict=True)
    if (ROOT / 'generations').resolve() not in data.parents:
        raise ValueError('staging data outside generations')
    remove_container(STAGING)
    create_container(STAGING, data, state['image'], ACTIVE_PORT)


def state_backup():
    result = {}
    for name in ('active.json', 'previous-active.json', 'last-success.json'):
        path = ROOT / name
        result[name] = path.read_bytes() if path.exists() else None
    return result


def restore_state(backup):
    for name, content in backup.items():
        path = ROOT / name
        if content is None:
            path.unlink(missing_ok=True)
            continue
        temporary = path.with_suffix(f'{path.suffix}.restore')
        temporary.write_bytes(content)
        temporary.chmod(0o600)
        temporary.replace(path)


def replace_transactionally(target, previous, commit):
    saved = state_backup()
    try:
        replace_staging(target)
        commit()
    except BaseException:
        try:
            if previous:
                replace_staging(previous)
            else:
                remove_container(STAGING)
        finally:
            restore_state(saved)
        raise


def promote(record_success=True):
    candidate = candidate_state()
    receipt = read_json(ROOT / 'verified-candidate.json')
    if receipt['candidate_id'] != verification_receipt(candidate)['candidate_id']:
        raise ValueError('candidate has not passed authorized encrypted-budget verification')
    assert_tailnet_authorization()
    previous = read_json(ROOT / 'active.json') if (ROOT / 'active.json').exists() else None
    remove_container(CANDIDATE)

    def commit():
        if previous:
            write_json(ROOT / 'previous-active.json', previous)
        write_json(ROOT / 'active.json', candidate)
        if record_success:
            write_json(ROOT / 'last-success.json', {'timestamp': time.time(), **verification_receipt(candidate)})

    replace_transactionally(candidate, previous, commit)
    if record_success:
        (ROOT / 'stale.json').unlink(missing_ok=True)
    return candidate


def rollback():
    previous = read_json(ROOT / 'previous-active.json')
    current = read_json(ROOT / 'active.json') if (ROOT / 'active.json').exists() else None
    if not current:
        raise ValueError('active staging state is missing')
    remove_container(CANDIDATE)
    create_container(CANDIDATE, Path(previous['data']).resolve(strict=True), previous['image'], CANDIDATE_PORT)
    remove_container(CANDIDATE)

    def commit():
        write_json(ROOT / 'previous-active.json', current)
        write_json(ROOT / 'active.json', previous)

    replace_transactionally(previous, current, commit)


def resolve_master_image():
    docker('pull', MASTER, timeout=180)
    digests = docker('image', 'inspect', '--format', '{{join .RepoDigests "\\n"}}', MASTER).splitlines()
    image = next((digest for digest in digests if DIGEST.fullmatch(digest)), None)
    if not image:
        raise RuntimeError('published master image has no pinned fork digest')
    return image


def cleanup_runtime(now, cutoff):
    protected = set()
    for name in ('active.json', 'previous-active.json', 'candidate.json'):
        path = ROOT / name
        if path.exists():
            state = read_json(path)
            protected.add(state['generation'])
    for directory, protected_names in (
        (ROOT / 'spool', set()),
        (ROOT / 'generations', protected),
    ):
        if not directory.exists():
            continue
        for path in directory.iterdir():
            if path.is_dir() and not path.is_symlink() and path.name not in protected_names:
                if path.stat().st_mtime < cutoff:
                    shutil.rmtree(path)


def cleanup_snapshots(directory=BACKUPS, now=None, keep_days=14):
    now = time.time() if now is None else now
    cutoff = now - keep_days * 86400
    if directory.exists():
        for path in directory.iterdir():
            if (path.is_dir() and not path.is_symlink()
                    and (path.name.startswith('actual-consistent-')
                         or (path.name.startswith('.actual-consistent-') and path.name.endswith('.partial')))):
                if path.stat().st_mtime < cutoff:
                    shutil.rmtree(path)
    cleanup_runtime(now, cutoff)


def freshness():
    cleanup_snapshots()
    marker = ROOT / 'last-success.json'
    if (ROOT / 'stale.json').exists() or not marker.exists() or time.time() - read_json(marker)['timestamp'] > 26 * 3600:
        alert('snapshot refresh stale over 26 hours')
        raise RuntimeError('staging stale')


def systemd_units(script):
    command = f'/usr/bin/python3 {script}'
    return {
        'actual-prod-watchdog.service': '\n'.join((
            '[Unit]', 'Description=Recover unchanged Actual production container after boot',
            'After=default.target', '', '[Service]', 'Type=oneshot',
            'EnvironmentFile=%h/.config/actual-staging/alert.env',
            'Restart=on-failure', 'RestartSec=2s', f'ExecStart={command} recover', '',
            '[Install]', 'WantedBy=default.target', '',
        )),
        'actual-staging-refresh.service': '\n'.join((
            '[Unit]', 'Description=Refresh private Actual staging', '', '[Service]', 'Type=oneshot',
            'EnvironmentFile=%h/.config/actual-staging/alert.env', f'ExecStart={command} refresh', '',
        )),
        'actual-staging-refresh.timer': '\n'.join((
            '[Unit]', 'Description=Daily private Actual staging refresh', '', '[Timer]',
            'OnCalendar=*-*-* 03:45:00', 'Persistent=true', 'Unit=actual-staging-refresh.service',
            '', '[Install]', 'WantedBy=timers.target', '',
        )),
        'actual-staging-image-sync.service': '\n'.join((
            '[Unit]', 'Description=Apply a newly published Actual master image', '', '[Service]', 'Type=oneshot',
            'EnvironmentFile=%h/.config/actual-staging/alert.env', f'ExecStart={command} sync-image', '',
        )),
        'actual-staging-image-sync.timer': '\n'.join((
            '[Unit]', 'Description=Detect newly published Actual master images', '', '[Timer]',
            'OnBootSec=3min', 'OnUnitInactiveSec=5min', 'Unit=actual-staging-image-sync.service',
            '', '[Install]', 'WantedBy=timers.target', '',
        )),
        'actual-staging-freshness.service': '\n'.join((
            '[Unit]', 'Description=Alert stale Actual staging', '', '[Service]', 'Type=oneshot',
            'EnvironmentFile=%h/.config/actual-staging/alert.env', f'ExecStart={command} freshness', '',
        )),
        'actual-staging-freshness.timer': '\n'.join((
            '[Unit]', 'Description=Check Actual staging freshness', '', '[Timer]',
            'OnCalendar=hourly', 'Persistent=true', 'Unit=actual-staging-freshness.service',
            '', '[Install]', 'WantedBy=timers.target', '',
        )),
    }


def install_units():
    unit_dir = ensure_dir(Path.home() / '.config/systemd/user')
    for name, content in systemd_units(Path(__file__).resolve()).items():
        path = unit_dir / name
        path.write_text(content)
        path.chmod(0o600)
    run('systemctl', '--user', 'daemon-reload')


def enable_units():
    assert_tailnet_authorization()
    alert_configured()
    run(
        'systemctl', '--user', 'enable', '--now',
        'actual-prod-watchdog.service', 'actual-staging-refresh.timer',
        'actual-staging-image-sync.timer', 'actual-staging-freshness.timer',
    )


def refresh():
    try:
        image = resolve_master_image()
        snapshot_path = snapshot()
        restore(snapshot_path, image)
        verify_candidate()
        return promote()
    finally:
        cleanup_snapshots()


def sync_image():
    image = resolve_master_image()
    active = ROOT / 'active.json'
    if not active.exists():
        return 'awaiting-daily-snapshot'
    state = read_json(active)
    if state.get('image') == image:
        return 'unchanged'
    restore(BACKUPS / state['snapshot'], image)
    verify_candidate()
    return promote(record_success=False)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument(
        'action',
        choices=('snapshot', 'recover', 'restore', 'verify', 'promote', 'rollback', 'refresh', 'sync-image', 'freshness',
                 'alert-test', 'install-units', 'enable-units'),
    )
    parser.add_argument('--snapshot', type=Path)
    parser.add_argument('--image')
    parser.add_argument('--capture')
    args = parser.parse_args()
    try:
        if args.action == 'recover':
            recovery_locked(lambda: recover(capture=args.capture))
        elif args.action == 'freshness':
            locked(freshness)
        elif args.action == 'alert-test':
            alert('alert delivery test')
        elif args.action == 'install-units':
            install_units()
        elif args.action == 'enable-units':
            enable_units()
        elif args.action == 'snapshot':
            print(locked(snapshot))
        elif args.action == 'restore':
            if not args.snapshot or not args.image:
                parser.error('restore requires --snapshot and --image')
            print(locked(lambda: restore(args.snapshot, args.image)))
        elif args.action == 'verify':
            print(locked(verify_candidate))
        elif args.action == 'promote':
            print(locked(promote))
        elif args.action == 'rollback':
            print(locked(rollback))
        elif args.action == 'refresh':
            if args.image:
                parser.error('refresh does not accept --image; image-only rollout uses sync-image')
            print(locked(refresh))
        elif args.action == 'sync-image':
            print(locked(sync_image))
    except Exception:
        if args.action == 'refresh':
            try:
                write_json(ROOT / 'stale.json', {'timestamp': time.time(), 'reason': 'refresh failed'})
            except Exception:
                print('STALE STATE WRITE FAILED', file=sys.stderr)
        if args.action not in ('recover', 'freshness', 'alert-test'):
            try:
                alert('staging action failed; prior state preserved')
            except Exception:
                print('ALERT DELIVERY FAILED', file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
