#!/usr/bin/env python3
"""Fail-closed C00 Actual staging refresh helper.

Installed and enabled only during the approved C00 rehearsal. It never builds
images and never uses production credentials or integrations.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request

PROD = 'actual-budget'
STAGING = 'actual-staging'
CANDIDATE = 'actual-staging-candidate'
SOURCE = Path('/home/congvc/projects/oss/actual-budget/data')
BACKUPS = Path('/home/congvc/projects/oss/actual-budget/backups')
ROOT = Path('/home/congvc/projects/oss/actual-staging')
SHARED_LOCK = SOURCE.parent / '.actual-maintenance.lock'
IMAGE = 'ghcr.io/cheese-work/actual-server@sha256:'
MASTER = 'ghcr.io/cheese-work/actual-server:master'
DIGEST = re.compile(r'^ghcr.io/cheese-work/actual-server@sha256:[0-9a-f]{64}$')
ACTIVE_PORT = 15008
CANDIDATE_PORT = 15009


def run(*cmd, timeout=60):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def docker(*cmd, timeout=60):
    return run('docker', *cmd, timeout=timeout)


def prod():
    return json.loads(docker('inspect', PROD))[0]


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


def audit(root):
    result = {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('unsafe snapshot root')
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(base, name)
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise ValueError('unsafe file in data tree')
        for name in files:
            path = Path(base, name)
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1048576), b''):
                    digest.update(block)
            result[str(path.relative_to(root))] = [path.stat().st_size, digest.hexdigest()]
    return result


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
    if not target:
        raise RuntimeError('alert destination missing')
    run(
        'env', 'HERMES_HOME=/home/congvc/.hermes', 'hermes', 'send', '--to', target,
        f'CHE-828 staging: {message}', timeout=20,
    )


def locked(action):
    ensure_dir(ROOT)
    if SHARED_LOCK.is_symlink():
        raise ValueError('unsafe shared lock')
    with SHARED_LOCK.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return action()


def assert_prod_identity(before=None):
    current = prod()
    if current['HostConfig']['Binds'] != [f'{SOURCE}:/data:rw']:
        raise RuntimeError('unexpected production mount; refusing restart')
    if before and (current['Id'] != before['Id'] or current['Image'] != before['Image']):
        raise RuntimeError('production container identity changed')
    return current


def recover(before=None):
    current = assert_prod_identity(before)
    if not current['State']['Running']:
        docker('start', PROD, timeout=15)
    if not assert_prod_identity(before)['State']['Running']:
        raise RuntimeError('production restart failed')


def schedule_watchdog(stamp):
    run(
        'systemd-run', '--user', '--collect', f'--unit=actual-prod-watchdog-{stamp}',
        '--on-active=30s', sys.executable, str(Path(__file__).resolve()), 'recover',
        timeout=10,
    )


def snapshot():
    before = assert_prod_identity()
    ensure_dir(ROOT / 'spool')
    ensure_snapshot_store()
    stamp = str(time.time_ns())
    copied = ROOT / 'spool' / stamp
    copied.mkdir(mode=0o700)
    schedule_watchdog(stamp)
    started = time.monotonic()
    try:
        docker('stop', '--time', '10', PROD, timeout=15)
        if prod()['State']['Running']:
            raise RuntimeError('graceful stop timed out')
        files = audit(SOURCE)
        required = sum(size for size, _ in files.values())
        disk = shutil.disk_usage(ROOT)
        if disk.free - required < max(5 * 1024**3, disk.total // 5):
            raise RuntimeError('disk reserve insufficient')
        shutil.copytree(SOURCE, copied / 'data', symlinks=False)
        if time.monotonic() - started > 25:
            raise RuntimeError('copy missed the watchdog deadline')
    finally:
        recover(before)
    if time.monotonic() - started > 30:
        raise RuntimeError('production deadline exceeded')
    try:
        copied_files = audit(copied / 'data')
        if copied_files != files:
            raise RuntimeError('spooled snapshot checksum mismatch')
        count = budget_count(copied / 'data')
        write_json(
            copied / 'manifest.json',
            {'files': copied_files, 'budget_count': count, 'source_image': before['Image'], 'timestamp': stamp},
        )
        partial = BACKUPS / f'.actual-consistent-{stamp}.partial'
        target = BACKUPS / f'actual-consistent-{stamp}'
        if partial.exists() or target.exists():
            raise RuntimeError('snapshot name collision')
        shutil.copytree(copied, partial, symlinks=False)
        try:
            if audit(partial / 'data') != copied_files:
                raise RuntimeError('archive checksum mismatch')
            partial.rename(target)
        except BaseException:
            shutil.rmtree(partial)
            raise
        return target
    finally:
        shutil.rmtree(copied)


def sanitize(root, password_hash):
    if not password_hash.startswith('$argon2id$'):
        raise ValueError('staging-specific password hash required')
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


def approved_snapshot(path):
    path = path.resolve(strict=True)
    if BACKUPS.resolve() not in path.parents or not path.name.startswith('actual-consistent-'):
        raise ValueError('snapshot outside approved store')
    manifest = read_json(path / 'manifest.json')
    if audit(path / 'data') != manifest['files']:
        raise ValueError('archive checksum mismatch')
    count = budget_count(path / 'data')
    if count != manifest['budget_count']:
        raise ValueError('source snapshot count mismatch')
    if (path / 'data/config.json').exists() or (path / 'data/.env').exists():
        raise ValueError('source contains inherited server configuration')
    return path, manifest, count


def create_container(name, data, image, port):
    network = json.loads(docker('network', 'inspect', 'actual-staging-isolated'))[0]
    if not network['Internal'] or network['Driver'] != 'bridge':
        raise ValueError('staging network must be an internal bridge')
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
            docker('stop', '--time', '10', name, timeout=15)
        docker('rm', name)


def verification_receipt(candidate):
    identity = json.dumps(
        {'snapshot': candidate['snapshot'], 'image': candidate['image']},
        sort_keys=True, separators=(',', ':'),
    ).encode()
    return {
        'candidate_id': hashlib.sha256(identity).hexdigest(),
        'snapshot': candidate['snapshot'],
        'image': candidate['image'],
        'verified_at': int(time.time()),
    }


def restore(snapshot_path, image):
    if not DIGEST.fullmatch(image):
        raise ValueError('only published fork digest allowed')
    path, manifest, expected = approved_snapshot(snapshot_path)
    base = ensure_dir(ROOT / 'generations')
    candidate_data = base / path.name
    if candidate_data.exists():
        raise RuntimeError('candidate name collision')
    shutil.copytree(path / 'data', candidate_data, symlinks=False)
    try:
        if sanitize(candidate_data, staging_password_hash()) != expected:
            raise RuntimeError('restored snapshot count mismatch')
        remove_container(CANDIDATE)
        create_container(CANDIDATE, candidate_data, image, CANDIDATE_PORT)
        candidate = {
            'snapshot': path.name,
            'image': image,
            'budget_count': expected,
            'data': str(candidate_data),
            'manifest': manifest,
        }
        write_json(ROOT / 'candidate.json', candidate)
        return candidate
    except BaseException:
        remove_container(CANDIDATE)
        shutil.rmtree(candidate_data, ignore_errors=True)
        raise


def candidate_state():
    candidate = read_json(ROOT / 'candidate.json')
    data = Path(candidate['data']).resolve(strict=True)
    generations = (ROOT / 'generations').resolve()
    if generations not in data.parents:
        raise ValueError('candidate data outside staging root')
    if not DIGEST.fullmatch(candidate['image']):
        raise ValueError('candidate image is not a pinned digest')
    return candidate


def verify_candidate():
    candidate = candidate_state()
    verifier = ROOT / 'verify-encrypted-budget'
    if verifier.is_symlink() or not verifier.is_file() or verifier.stat().st_mode & 0o077:
        raise ValueError('authorized encrypted-budget verifier must be private and executable')
    if not os.access(verifier, os.X_OK):
        raise ValueError('authorized encrypted-budget verifier is not executable')
    run(str(verifier), candidate['snapshot'], candidate['image'], timeout=120)
    receipt = verification_receipt(candidate)
    write_json(ROOT / 'verified-candidate.json', receipt)
    return receipt


def assert_tailnet_authorization():
    authorization = read_json(ROOT / 'tailnet-authorized.json')
    if not authorization.get('host') or authorization.get('funnel') is not False:
        raise ValueError('tailnet ACL authorization missing or permits Funnel')
    status = run('tailscale', 'serve', 'status', '--json', timeout=10)
    if '127.0.0.1:15008' not in status or authorization['host'] not in status:
        raise ValueError('tailnet Serve endpoint does not match approved staging origin')
    funnel = run('tailscale', 'funnel', 'status', '--json', timeout=10)
    if 'https://' in funnel:
        raise ValueError('Funnel must remain disabled for staging')


def replace_staging(state):
    data = Path(state['data']).resolve(strict=True)
    if (ROOT / 'generations').resolve() not in data.parents:
        raise ValueError('staging data outside generations')
    remove_container(STAGING)
    create_container(STAGING, data, state['image'], ACTIVE_PORT)


def promote():
    candidate = candidate_state()
    receipt = read_json(ROOT / 'verified-candidate.json')
    if receipt['candidate_id'] != verification_receipt(candidate)['candidate_id']:
        raise ValueError('candidate has not passed authorized encrypted-budget verification')
    assert_tailnet_authorization()
    previous = read_json(ROOT / 'active.json') if (ROOT / 'active.json').exists() else None
    remove_container(CANDIDATE)
    try:
        replace_staging(candidate)
    except BaseException:
        if previous:
            replace_staging(previous)
        raise
    if previous:
        write_json(ROOT / 'previous-active.json', previous)
    write_json(ROOT / 'active.json', candidate)
    write_json(ROOT / 'last-success.json', {'timestamp': time.time(), **verification_receipt(candidate)})
    return candidate


def rollback():
    previous = read_json(ROOT / 'previous-active.json')
    replace_staging(previous)
    current = read_json(ROOT / 'active.json') if (ROOT / 'active.json').exists() else None
    if current:
        write_json(ROOT / 'previous-active.json', current)
    write_json(ROOT / 'active.json', previous)


def resolve_master_image():
    docker('pull', MASTER, timeout=180)
    digests = docker('image', 'inspect', '--format', '{{join .RepoDigests "\\n"}}', MASTER).splitlines()
    image = next((digest for digest in digests if DIGEST.fullmatch(digest)), None)
    if not image:
        raise RuntimeError('published master image has no pinned fork digest')
    return image


def cleanup_snapshots(directory=BACKUPS, now=None, keep_days=14):
    now = time.time() if now is None else now
    cutoff = now - keep_days * 86400
    for path in directory.iterdir():
        if path.is_dir() and not path.is_symlink() and path.name.startswith('actual-consistent-'):
            if path.stat().st_mtime < cutoff:
                shutil.rmtree(path)


def freshness():
    marker = ROOT / 'last-success.json'
    if not marker.exists() or time.time() - read_json(marker)['timestamp'] > 26 * 3600:
        alert('snapshot refresh stale over 26 hours')
        raise RuntimeError('staging stale')


def systemd_units(script):
    command = f'/usr/bin/python3 {script}'
    return {
        'actual-prod-watchdog.service': '\n'.join((
            '[Unit]', 'Description=Recover unchanged Actual production container after boot',
            'After=default.target', '', '[Service]', 'Type=oneshot',
            f'ExecStart={command} recover', '', '[Install]', 'WantedBy=default.target', '',
        )),
        'actual-staging-refresh.service': '\n'.join((
            '[Unit]', 'Description=Refresh private Actual staging', '', '[Service]', 'Type=oneshot',
            f'ExecStart={command} refresh', '',
        )),
        'actual-staging-refresh.timer': '\n'.join((
            '[Unit]', 'Description=Daily private Actual staging refresh', '', '[Timer]',
            'OnCalendar=*-*-* 03:45:00', 'Persistent=true', 'Unit=actual-staging-refresh.service',
            '', '[Install]', 'WantedBy=timers.target', '',
        )),
        'actual-staging-image-sync.service': '\n'.join((
            '[Unit]', 'Description=Apply a newly published Actual master image', '', '[Service]', 'Type=oneshot',
            f'ExecStart={command} sync-image', '',
        )),
        'actual-staging-image-sync.timer': '\n'.join((
            '[Unit]', 'Description=Detect newly published Actual master images', '', '[Timer]',
            'OnBootSec=3min', 'OnUnitInactiveSec=5min', 'Unit=actual-staging-image-sync.service',
            '', '[Install]', 'WantedBy=timers.target', '',
        )),
        'actual-staging-freshness.service': '\n'.join((
            '[Unit]', 'Description=Alert stale Actual staging', '', '[Service]', 'Type=oneshot',
            f'ExecStart={command} freshness', '',
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
    run(
        'systemctl', '--user', 'enable', '--now',
        'actual-prod-watchdog.service', 'actual-staging-refresh.timer',
        'actual-staging-image-sync.timer', 'actual-staging-freshness.timer',
    )


def refresh(image=None):
    image = image or resolve_master_image()
    snapshot_path = snapshot()
    restore(snapshot_path, image)
    verify_candidate()
    promoted = promote()
    cleanup_snapshots()
    return promoted


def sync_image():
    image = resolve_master_image()
    active = ROOT / 'active.json'
    if active.exists() and read_json(active).get('image') == image:
        return 'unchanged'
    return refresh(image)


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
    args = parser.parse_args()
    try:
        if args.action == 'recover':
            recover()
        elif args.action == 'freshness':
            freshness()
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
            print(locked(lambda: refresh(args.image)))
        elif args.action == 'sync-image':
            print(locked(sync_image))
    except Exception:
        if args.action not in ('recover', 'freshness', 'alert-test'):
            try:
                alert(f'{args.action} failed; prior staging preserved')
            except Exception:
                print('ALERT DELIVERY FAILED', file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
