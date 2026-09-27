"""Offline staging checks; run on X99 with python3 -m unittest discover -s ops."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

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


if __name__ == '__main__':
    unittest.main()
