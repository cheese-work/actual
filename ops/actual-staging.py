#!/usr/bin/env python3
"""C00 Actual staging: closed snapshot, private candidate, explicit promotion."""
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
SOURCE = Path('/home/congvc/projects/oss/actual-budget/data')
BACKUPS = Path('/home/congvc/projects/oss/actual-budget/backups')
ROOT = Path('/home/congvc/projects/oss/actual-staging')
IMAGE = 'ghcr.io/cheese-work/actual-server@sha256:'
DIGEST = re.compile(r'^ghcr.io/cheese-work/actual-server@sha256:[0-9a-f]{64}$')


def run(*cmd, timeout=60):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def docker(*cmd, timeout=60):
    return run('docker', *cmd, timeout=timeout)


def prod():
    return json.loads(docker('inspect', PROD))[0]


def audit(root):
    result = {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('unsafe snapshot root')
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            p = Path(base, name)
            if p.is_symlink() or not (p.is_dir() or p.is_file()):
                raise ValueError('unsafe file in data tree')
        for name in files:
            p = Path(base, name)
            digest = hashlib.sha256()
            with p.open('rb') as stream:
                for block in iter(lambda: stream.read(1048576), b''):
                    digest.update(block)
            result[str(p.relative_to(root))] = [p.stat().st_size, digest.hexdigest()]
    return result


def budget_count(root):
    dbs = list(root.rglob('*.sqlite'))
    account = root / 'server-files/account.sqlite'
    if not account.is_file() or not dbs:
        raise ValueError('missing SQLite data')
    for path in dbs:
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as conn:
            if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('database integrity check failed')
    with sqlite3.connect(f'file:{account}?mode=ro', uri=True) as conn:
        return conn.execute('SELECT count(*) FROM files WHERE deleted = 0').fetchone()[0]


def alert(message):
    target = os.environ.get('ACTUAL_ALERT_TARGET')
    if not target:
        raise RuntimeError('alert destination missing')
    # Use an existing Hermes credential store, never the production bot.
    run('env', 'HERMES_HOME=/home/congvc/.hermes', 'hermes', 'send', '--to', target,
        f'CHE-828 staging: {message}', timeout=20)


def locked(fn):
    ROOT.mkdir(mode=0o700, exist_ok=True)
    ROOT.chmod(0o700)
    with (ROOT / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fn()


def recover():
    original = prod()
    if original['HostConfig']['Binds'] != [f'{SOURCE}:/data:rw']:
        raise RuntimeError('unexpected production mount; refusing restart')
    if not original['State']['Running']:
        docker('start', PROD, timeout=15)
    if not prod()['State']['Running']:
        raise RuntimeError('production restart failed')


def snapshot():
    before = prod()
    if not before['State']['Running'] or before['HostConfig']['Binds'] != [f'{SOURCE}:/data:rw']:
        raise RuntimeError('unexpected production state')
    disk = shutil.disk_usage(ROOT)
    if disk.free - sum(p.stat().st_size for p in SOURCE.rglob('*') if p.is_file()) < max(5 * 1024**3, disk.total // 5):
        raise RuntimeError('disk reserve insufficient')
    spool = ROOT / 'spool'
    spool.mkdir(mode=0o700, exist_ok=True)
    stamp = str(int(time.time()))
    copied = spool / stamp
    copied.mkdir(mode=0o700)
    # Independent transient timer survives refresh cancellation. A persistent
    # boot recovery unit is installed separately before any daily enablement.
    run('systemd-run', '--user', f'--unit=actual-prod-watchdog-{stamp}',
        '--on-active=30s', sys.executable, str(Path(__file__).resolve()), 'recover', timeout=10)
    start = time.monotonic()
    try:
        docker('kill', '--signal=TERM', PROD, timeout=5)
        for _ in range(100):
            if not prod()['State']['Running']:
                break
            time.sleep(0.05)
        else:
            raise RuntimeError('graceful stop timed out')
        if time.monotonic() - start > 10:
            raise RuntimeError('graceful stop too slow')
        audit(SOURCE)
        shutil.copytree(SOURCE, copied / 'data', symlinks=True)
        if time.monotonic() - start > 25 or prod()['State']['Running']:
            raise RuntimeError('copy missed the watchdog deadline')
    finally:
        recover()
    if time.monotonic() - start > 30 or prod()['Id'] != before['Id'] or prod()['Image'] != before['Image']:
        raise RuntimeError('production deadline or identity check failed')
    try:
        files = audit(copied / 'data')
        count = budget_count(copied / 'data')
        (copied / 'manifest.json').write_text(json.dumps({'files': files, 'budget_count': count,
                                                         'source_image': before['Image'], 'timestamp': stamp}))
        partial = BACKUPS / f'.actual-consistent-{stamp}.partial'
        target = BACKUPS / f'actual-consistent-{stamp}'
        if partial.exists() or target.exists():
            raise RuntimeError('snapshot name collision')
        shutil.copytree(copied, partial, symlinks=True)
        try:
            if audit(partial / 'data') != files:
                raise RuntimeError('copied snapshot checksum mismatch')
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
        for table, required in {'sessions': {'token', 'user_id', 'auth_method'},
                                'auth': {'method', 'extra_data', 'active'},
                                'secrets': {'name', 'value'},
                                'pending_openid_requests': {'state'}}.items():
            if not required <= {r[1] for r in db.execute(f'PRAGMA table_info({table})')}:
                raise ValueError('unsupported auth schema')
        if db.execute("SELECT count(*) FROM users WHERE user_name = '' AND owner = 1 AND enabled = 1").fetchone()[0] != 1:
            raise ValueError('password owner missing or ambiguous')
        db.execute('BEGIN IMMEDIATE')
        for table in ('sessions', 'pending_openid_requests', 'secrets', 'auth'):
            db.execute(f'DELETE FROM {table}')
        db.execute("INSERT INTO auth (method, display_name, extra_data, active) VALUES ('password', 'Password', ?, 1)",
                   (password_hash,))
        db.commit()
        for table in ('sessions', 'pending_openid_requests', 'secrets'):
            if db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]:
                raise ValueError('sanitation verification failed')
    return budget_count(root)


def probe():
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:15008/', timeout=2) as response:
                if response.status == 200:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('candidate failed HTTP readiness')


def restore(snapshot_path, image):
    path = snapshot_path.resolve(strict=True)
    if BACKUPS.resolve() not in path.parents or not path.name.startswith('actual-consistent-'):
        raise ValueError('snapshot outside approved store')
    if not DIGEST.fullmatch(image):
        raise ValueError('only published fork digest allowed')
    manifest = json.loads((path / 'manifest.json').read_text())
    if audit(path / 'data') != manifest['files']:
        raise ValueError('archive checksum mismatch')
    expected = budget_count(path / 'data')
    if expected != manifest['budget_count']:
        raise ValueError('source file count mismatch')
    if (path / 'data/config.json').exists() or (path / 'data/.env').exists():
        raise ValueError('source contains inherited server configuration')
    base = ROOT / 'generations'
    base.mkdir(mode=0o700, exist_ok=True)
    candidate_data = base / path.name
    if candidate_data.exists():
        raise RuntimeError('candidate name collision')
    shutil.copytree(path / 'data', candidate_data, symlinks=True)
    try:
        if sanitize(candidate_data, (ROOT / 'password.hash').read_text().strip()) != expected:
            raise RuntimeError('restored file count mismatch')
        network = json.loads(docker('network', 'inspect', 'actual-staging-isolated'))[0]
        if not network['Internal'] or network['Driver'] != 'bridge':
            raise ValueError('candidate network must be an internal bridge')
        candidate = 'actual-staging-candidate'
        if candidate in docker('ps', '-a', '--format', '{{.Names}}').splitlines():
            raise RuntimeError('candidate already exists')
        docker('create', '--name', candidate, '--network', 'actual-staging-isolated',
               '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-p', '127.0.0.1:15008:5006',
               '-v', f'{candidate_data}:/data:rw', '-e', 'NODE_ENV=production', image)
        docker('start', candidate)
        probe()
        # Deliberately do not replace known-good staging: encrypted-budget access
        # requires an authorized human verifier before a candidate is promoted.
        return candidate_data
    except BaseException:
        if 'actual-staging-candidate' in docker('ps', '-a', '--format', '{{.Names}}').splitlines():
            docker('rm', '-f', 'actual-staging-candidate')
        shutil.rmtree(candidate_data)
        raise


def freshness():
    marker = ROOT / 'last-success.json'
    if not marker.exists() or time.time() - json.loads(marker.read_text())['timestamp'] > 26 * 3600:
        alert('snapshot refresh stale over 26 hours')
        raise RuntimeError('staging stale')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('snapshot', 'recover', 'restore', 'freshness'))
    parser.add_argument('--snapshot', type=Path)
    parser.add_argument('--image')
    args = parser.parse_args()
    if args.action == 'recover':
        recover()
    elif args.action == 'freshness':
        freshness()
    else:
        try:
            if args.action == 'snapshot':
                print(locked(snapshot))
            elif args.snapshot and args.image:
                print(locked(lambda: restore(args.snapshot, args.image)))
            else:
                parser.error('restore requires --snapshot and --image')
        except Exception:
            try:
                alert(f'{args.action} failed; prior staging preserved')
            except Exception:
                print('ALERT DELIVERY FAILED', file=sys.stderr)
            raise


if __name__ == '__main__':
    main()
