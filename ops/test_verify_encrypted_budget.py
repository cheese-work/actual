"""Offline checks for ops/verify-encrypted-budget against a fake Actual server (no real credentials/data)."""
import base64
import contextlib
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HERE = Path(__file__).parent


def load(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(HERE / filename))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    loader.exec_module(module)
    return module


verifier = load('verify_encrypted_budget', 'verify-encrypted-budget')
staging = load('actual_staging_for_verifier', 'actual-staging.py')

PASSWORD = 'fixture-staging-password'
E2E = 'fixture-e2e-key'
SALT = 'fixture-salt'
KEY_ID = 'fixture-key-id'
FILE_ID = 'fixture-file-id'
IMAGE = 'ghcr.io/cheese-work/actual-server@sha256:' + 'a' * 64
SNAPSHOT = 'actual-consistent-fixture'
TOKEN = 'fixture-session-token'


def seal(key, plaintext):
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, plaintext, None)
    meta = {'keyId': KEY_ID, 'algorithm': 'aes-256-gcm', 'iv': base64.b64encode(iv).decode(),
            'authTag': base64.b64encode(sealed[-16:]).decode()}
    return sealed[:-16], meta


def derive(secret):
    return hashlib.pbkdf2_hmac('sha512', secret.encode(), SALT.encode(), 10000, 32)


class Server(ThreadingHTTPServer):
    def handle_error(self, *args):  # client-abandoned requests (timeout tests) are expected
        pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, data, status='ok', raw=None):
        body = raw if raw is not None else json.dumps({'status': status, 'data': data}).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')

    def do_GET(self):
        self.route(None)

    def do_POST(self):
        self.route(self.body())

    def route(self, body):
        state = self.server.state
        state['seen'].append(self.path)
        if state.get('delay'):
            time.sleep(state['delay'])
        if self.path == '/account/login':
            if body.get('password') != PASSWORD:
                return self.reply('invalid-password', status='error')
            return self.reply({'token': TOKEN})
        if self.headers.get('x-actual-token') != TOKEN:
            return self.reply('unauthorized', status='error')
        if self.path == '/sync/list-user-files':
            return self.reply([{'fileId': f, 'deleted': 0} for f in state['files']])
        if self.path == '/sync/get-user-file-info':
            return self.reply({'encryptMeta': state['blob_meta']})
        if self.path == '/sync/user-get-key':
            return self.reply({'id': KEY_ID, 'salt': SALT, 'test': state['test']})
        if self.path == '/sync/download-user-file':
            return self.reply(None, raw=state['blob'])
        self.send_error(404)


class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'root'
        (self.root / 'generations/gen/server-files').mkdir(parents=True)
        self.set_budgets([FILE_ID])
        key = derive(E2E)
        blob, blob_meta = seal(key, b'PK\x03\x04fixture-budget')
        test_value, test_meta = seal(key, b'fixture-test-message')
        (self.root / 'generations/gen/user-files').mkdir()
        (self.root / f'generations/gen/user-files/file-{FILE_ID}.blob').write_bytes(blob)
        self.state = {
            'files': [FILE_ID], 'blob': blob, 'blob_meta': blob_meta, 'seen': [],
            'test': json.dumps({'value': base64.b64encode(test_value).decode(), 'meta': test_meta}),
        }
        self.server = Server(('127.0.0.1', 0), Handler)
        self.server.state = self.state
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.write_secret('password.txt', PASSWORD)
        self.write_secret('e2e.key', E2E)
        patches = [
            mock.patch.object(verifier, 'ROOT', self.root),
            mock.patch.object(verifier, 'BASE', f'http://127.0.0.1:{self.server.server_port}'),
            mock.patch.object(verifier, 'PASSWORD_FILE', Path(self.tmp.name) / 'password.txt'),
            mock.patch.object(verifier, 'KEY_FILE', Path(self.tmp.name) / 'e2e.key'),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def write_secret(self, name, text):
        path = Path(self.tmp.name) / name
        path.write_text(text + '\n')
        path.chmod(0o600)

    def write_candidate(self):
        path = self.root / 'candidate.json'
        path.write_text(json.dumps(self.candidate))
        path.chmod(0o600)

    def set_budgets(self, ids, candidate_edit=None):
        data = self.root / 'generations/gen'
        with contextlib.closing(sqlite3.connect(data / 'server-files/account.sqlite')) as db:
            db.execute('DROP TABLE IF EXISTS files')
            db.execute('CREATE TABLE files(id TEXT, deleted INTEGER)')
            db.executemany('INSERT INTO files VALUES (?, 0)', [(i,) for i in ids])
            db.commit()
        self.candidate = {
            'snapshot': SNAPSHOT, 'image': IMAGE, 'generation': 'gen', 'budget_count': len(ids),
            'inventory': {'x': [1, 'y']}, 'manifest': {'files': {}}, 'data': str(data),
        }
        if candidate_edit:
            candidate_edit(self.candidate)
        self.write_candidate()
        self.candidate_id = staging.verification_receipt(self.candidate)['candidate_id']

    def run_main(self, *args):
        args = args or (SNAPSHOT, IMAGE, self.candidate_id)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = verifier.main(['verify-encrypted-budget', *args])
        for secret in (PASSWORD, E2E, TOKEN, KEY_ID, 'fixture-budget'):
            self.assertNotIn(secret, out.getvalue() + err.getvalue())
        return code, err.getvalue()

    def test_success_exits_zero_and_cleans_up(self):
        before = sorted(p.name for p in Path(self.tmp.name).rglob('*'))
        code, err = self.run_main()
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(sorted(p.name for p in Path(self.tmp.name).rglob('*')), before)
        self.assertIn('/sync/download-user-file', self.state['seen'])

    def test_wrong_staging_password(self):
        self.write_secret('password.txt', 'wrong')
        self.assertEqual(self.run_main()[0], 1)
        self.assertEqual(self.state['seen'], ['/account/login'])

    def test_wrong_e2e_key(self):
        self.write_secret('e2e.key', 'wrong')
        code, err = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn('decrypt failure', err)
        self.assertNotIn('/sync/download-user-file', self.state['seen'])

    def test_missing_budget(self):
        self.state['files'] = []
        self.set_budgets([])
        self.assertEqual(self.run_main()[0], 1)

    def test_multiple_budgets(self):
        self.state['files'] = [FILE_ID, 'other']
        self.set_budgets([FILE_ID, 'other'])
        self.assertIn('exactly one', self.run_main()[1])

    def test_server_lists_different_budget_than_candidate(self):
        self.state['files'] = ['other']
        self.assertIn('single candidate budget', self.run_main()[1])

    def test_unencrypted_budget_rejected(self):
        self.state['blob_meta'] = None
        self.assertIn('not encrypted', self.run_main()[1])

    def test_wrong_candidate_identity(self):
        for args in ((SNAPSHOT, IMAGE, '0' * 64), ('other-snapshot', IMAGE, self.candidate_id),
                     (SNAPSHOT, IMAGE.replace('a', 'b'), self.candidate_id), (SNAPSHOT, 'latest', self.candidate_id)):
            self.assertEqual(self.run_main(*args)[0], 1)
        self.assertEqual(self.state['seen'], [])  # rejected before any network call

    def test_tampered_candidate_record(self):
        self.candidate['manifest'] = {'files': {'evil': 1}}
        self.write_candidate()
        self.assertIn('identity mismatch', self.run_main()[1])

    def test_candidate_data_outside_root(self):
        def edit(candidate):
            candidate['data'] = self.tmp.name
        self.set_budgets([FILE_ID], edit)
        self.assertIn('outside staging root', self.run_main()[1])

    def test_timeout(self):
        self.state['delay'] = 2
        with mock.patch.object(verifier, 'REQUEST_SECONDS', 0.3):
            code, err = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn('request failed', err)

    def test_deadline_exceeded(self):
        with mock.patch.object(verifier, 'DEADLINE_SECONDS', -1):
            self.assertIn('deadline', self.run_main()[1])

    def test_unreachable_endpoint(self):
        self.server.shutdown()
        self.server.server_close()
        self.assertEqual(self.run_main()[0], 1)

    def test_only_loopback_candidate_port_and_no_proxy(self):
        source = (HERE / 'verify-encrypted-budget').read_text()
        self.assertIn("BASE = 'http://127.0.0.1:15009'", source)
        self.assertIn('ProxyHandler({})', source)

    def test_served_blob_must_match_candidate_disk(self):
        # validly encrypted but different bytes: only the disk comparison can reject
        blob, meta = seal(derive(E2E), b'PK\x03\x04other-budget')
        self.state['blob'], self.state['blob_meta'] = blob, meta
        self.assertIn('does not match the candidate data', self.run_main()[1])

    def test_candidate_record_must_be_private(self):
        (self.root / 'candidate.json').chmod(0o644)
        self.assertIn('candidate record must be a private', self.run_main()[1])

    def test_symlinked_secret_rejected(self):
        real = Path(self.tmp.name) / 'e2e.key'
        link = Path(self.tmp.name) / 'link.key'
        link.symlink_to(real)
        with mock.patch.object(verifier, 'KEY_FILE', link):
            self.assertIn('not a symlink', self.run_main()[1])

    def test_generation_sibling_of_root_rejected(self):
        nested = self.root / 'generations/gen/nested'
        nested.mkdir()
        self.candidate['data'], self.candidate['generation'] = str(nested), 'nested'
        self.write_candidate()
        self.candidate_id = staging.verification_receipt(self.candidate)['candidate_id']
        self.assertIn('outside staging root', self.run_main()[1])

    def test_secret_files_must_be_private(self):
        (Path(self.tmp.name) / 'e2e.key').chmod(0o644)
        self.assertIn('private regular file', self.run_main()[1])

    def test_bad_usage(self):
        self.assertEqual(self.run_main('only-one')[0], 2)


if __name__ == '__main__':
    unittest.main()
