"""Offline fault/rollback tests for c00-firewall-repair.sh.

Each case runs the exact script as root inside a disposable `--network none`
container with real iptables-nft, sudo and visudo, a fake `docker` serving
fixture JSON, and a copy of the C00 baseline captured 2026-09-30. Wrappers
inject failures or SIGTERM at a chosen firewall write. Needs Docker on X99.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import unittest

OPS = Path(__file__).resolve().parent
DOCKERFILE = (
    'FROM ubuntu:24.04\n'
    'RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends '
    'iptables sudo python3 iproute2 && rm -rf /var/lib/apt/lists/*\n'
)
IMAGE = 'che828-firewall-repair-test:' + hashlib.sha256(DOCKERFILE.encode()).hexdigest()[:12]
NET_ID = 'b2773bc7d6fad77f6df3a3c60a5ab8efe221822aca778baf954a5559e029c732'
PROD_ID = '397a9eda92489b77480aed31c86127fb91420d6648c7a4880a9f67f5c1a23b8e'
PROD_IMAGE = 'sha256:1c14eef351234f4b5dd0433865b5de89d70bdbdc57368d5b07e910662c6498f9'
FORWARD = ('DOCKER-USER DOCKER-FORWARD ts-forward ufw-before-logging-forward ufw-before-forward '
           'ufw-after-forward ufw-after-logging-forward ufw-reject-forward ufw-track-forward')
OLD_FORWARD = ('ts-forward DOCKER-USER DOCKER-FORWARD ufw-before-logging-forward ufw-before-forward '
               'ufw-after-forward ufw-after-logging-forward ufw-reject-forward ufw-track-forward')
WRITES = 13  # 2 chain creations + 11 rule inserts
ADDED_V4 = [
    '-N ACTUAL_STAGING_INPUT',
    '-N ACTUAL_STAGING_FORWARD',
    '-A INPUT -i act-stg0 -j ACTUAL_STAGING_INPUT',
    '-A FORWARD -i act-stg0 -j ACTUAL_STAGING_FORWARD',
    '-A DOCKER-USER -i act-stg0 -j ACTUAL_STAGING_FORWARD',
    '-A ACTUAL_STAGING_INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A ACTUAL_STAGING_INPUT -s 172.31.254.0/24 -d 172.31.254.1/32 -j DROP',
    '-A ACTUAL_STAGING_INPUT -j DROP',
    '-A ACTUAL_STAGING_FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A ACTUAL_STAGING_FORWARD -s 172.31.254.0/24 -d 172.26.0.2/32 -j DROP',
    '-A ACTUAL_STAGING_FORWARD -j DROP',
]
ADDED_V6 = ['-A INPUT -i act-stg0 -j DROP', '-A FORWARD -i act-stg0 -j DROP']
SUDOERS = '/etc/sudoers.d/che-828-staging-firewall-readonly'
# Objects left when write N took effect but reported failure (or a concurrent
# writer made it): never claimed, so rollback keeps them and demands recovery.
# Writes 3-8 land inside staging chains this run created, so they roll back.
UNCLAIMED = {
    1: (['-N ACTUAL_STAGING_INPUT'], []),
    2: (['-N ACTUAL_STAGING_FORWARD'], []),
    9: ([ADDED_V4[2], '-N ACTUAL_STAGING_INPUT'], []),
    10: ([ADDED_V4[4], '-N ACTUAL_STAGING_FORWARD'], []),
    11: ([ADDED_V4[3], '-N ACTUAL_STAGING_FORWARD'], []),
    12: ([], [ADDED_V6[0]]),
    13: ([], [ADDED_V6[1]]),
}

HARNESS = r'''
set -euo pipefail
useradd -M congvc
ip link add act-stg0 type dummy
for fam in iptables ip6tables; do
  ufw=ufw; [[ $fam == ip6tables ]] && ufw=ufw6
  input="ts-input $ufw-before-logging-input $ufw-before-input $ufw-after-input $ufw-after-logging-input $ufw-reject-input $ufw-track-input"
  forward=${BASELINE_FORWARD//ufw-/$ufw-}
  for chain in $input $forward; do $fam -N "$chain" 2>/dev/null || :; done
  $fam -P INPUT DROP; $fam -P FORWARD DROP
  for chain in $input; do $fam -A INPUT -j "$chain"; done
  for chain in $forward; do $fam -A FORWARD -j "$chain"; done
  $fam -A DOCKER-FORWARD -i act-stg0 -o act-stg0 -j ACCEPT
  $fam -A ts-forward -o tailscale0 -j ACCEPT
done
iptables -A ufw-before-input -p tcp --dport 22 -j ACCEPT
mkdir -p /fixture /fault
printf '%s' "$NETWORK_JSON" > /fixture/network.json
printf '%s' "$PROD_JSON" > /fixture/prod.json
printf '%s' "${PROD_AFTER_JSON:-$PROD_JSON}" > /fixture/prod-after.json
printf '%s' "$DOCKER_NAME" > /fixture/name
printf '%s' "$DOCKER_BACKEND" > /fixture/backend
printf '%s' "$FAULT_WRITE" > /fault/write
printf '%s' "$FAULT_MODE" > /fault/mode
chmod -R a+rX /fixture /fault
cat > /usr/bin/docker <<'SH'
#!/bin/sh
case "$*" in
  'info --format {{.Name}}') cat /fixture/name ;;
  'info --format {{.FirewallBackend.Driver}}') cat /fixture/backend ;;
  'network inspect actual-staging-isolated') cat /fixture/network.json ;;
  'inspect actual-budget')
    if [ -e /tmp/prod-seen ]; then cat /fixture/prod-after.json; else : > /tmp/prod-seen; cat /fixture/prod.json; fi ;;
  *) echo "unexpected docker $*" >&2; exit 99 ;;
esac
SH
chmod 0755 /usr/bin/docker
for fam in iptables ip6tables; do
  rm /usr/sbin/$fam
  cat > /usr/sbin/$fam <<SH
#!/bin/bash
case " \$* " in
  *' -N '*|*' -I '*)
    n=\$((\$(cat /tmp/writes 2>/dev/null || echo 0) + 1)); echo \$n > /tmp/writes
    if [[ \$n == \$(cat /fault/write) ]]; then
      [[ \$(cat /fault/mode) == term ]] && kill -TERM \$PPID
      [[ \$(cat /fault/mode) == term-after ]] && { /usr/sbin/xtables-nft-multi $fam "\$@"; kill -TERM \$PPID; exit 0; }
      [[ \$(cat /fault/mode) == fail-after ]] && { /usr/sbin/xtables-nft-multi $fam "\$@"; exit 1; }
      [[ \$(cat /fault/mode) == race ]] && { /usr/sbin/xtables-nft-multi $fam "\$@"; exec /usr/sbin/xtables-nft-multi $fam "\$@"; }
      exit 1
    fi ;;
  *' -D '*) [[ \$(cat /fault/mode) == delete ]] && exit 1 ;;
esac
exec /usr/sbin/xtables-nft-multi $fam "\$@"
SH
  chmod 0755 /usr/sbin/$fam
done
if [[ $FAULT_MODE == visudo || $FAULT_MODE == runuser ]]; then
  bin=/usr/sbin/$FAULT_MODE
  mv "$bin" "$bin.real"
  printf '#!/bin/sh\n[ "$1" = -cqf ] && exit 1\n[ "$1" = -u ] && exit 1\nexec %s.real "$@"\n' "$bin" > "$bin"
  chmod 0755 "$bin"
fi
if [[ $FAULT_MODE == race-sudoers ]]; then
  # A concurrent writer installs an identical view between validation and link.
  mv /usr/sbin/visudo /usr/sbin/visudo.real
  printf '#!/bin/sh\n[ "$1" = -cqf ] && cp -p "$2" %s\nexec /usr/sbin/visudo.real "$@"\n' \
    /etc/sudoers.d/che-828-staging-firewall-readonly > /usr/sbin/visudo
  chmod 0755 /usr/sbin/visudo
fi
eval "$EXTRA_SETUP"
state() { iptables -w -S; echo ---; ip6tables -w -S; echo ---; ls -A /etc/sudoers.d | grep -vx README || true; }
echo '@@BEFORE'; state
echo '@@OUT'
set +e
bash /ops/c00-firewall-repair.sh > /tmp/out 2> /tmp/err
code=$?
cat /tmp/out; echo '@@ERR'; cat /tmp/err; echo "@@CODE $code"
echo '@@AFTER'; state
if [[ ${RUN_HELPER:-} == 1 ]]; then
  echo '@@HELPER'
  runuser -u congvc -- python3 /ops/actual-staging.py firewall-check 2>&1; echo "helper=$?"
  stat -c '%u:%g:%a' /etc/sudoers.d/che-828-staging-firewall-readonly
  cat /etc/sudoers.d/che-828-staging-firewall-readonly
  runuser -u congvc -- sudo -n /usr/sbin/iptables -w -F INPUT >/dev/null 2>&1; echo "flush=$?"
  runuser -u congvc -- sudo -n /usr/sbin/iptables -w -D INPUT -i act-stg0 -j ACTUAL_STAGING_INPUT >/dev/null 2>&1; echo "delete=$?"
  runuser -u congvc -- sudo -n /usr/sbin/iptables -w -S INPUT >/dev/null 2>&1; echo "read=$?"
  echo '@@RERUN'
  bash /ops/c00-firewall-repair.sh 2>&1; echo "@@CODE $?"
  echo '@@AFTER-RERUN'; state
fi
'''


def network(**changes):
    value = {
        'Name': 'actual-staging-isolated', 'Id': NET_ID, 'Driver': 'bridge', 'Internal': True, 'EnableIPv6': False,
        'Options': {'com.docker.network.bridge.name': 'act-stg0',
                    'com.docker.network.bridge.enable_ip_masquerade': 'false'},
        'IPAM': {'Config': [{'Subnet': '172.31.254.0/24', 'Gateway': '172.31.254.1'}]},
        'Containers': {},
    }
    value.update(changes)
    return [value]


def production(**changes):
    value = {
        'Id': PROD_ID, 'Image': PROD_IMAGE,
        'State': {'Running': True, 'Health': {'Status': 'healthy'}},
        'NetworkSettings': {'Networks': {'actual-budget_default': {'IPAddress': '172.26.0.2'}}},
    }
    value.update(changes)
    return [value]


def sections(output):
    result, name = {}, None
    for line in output.splitlines():
        if line.startswith('@@'):
            name, _, rest = line[2:].partition(' ')
            if name == 'CODE':
                result.setdefault('CODES', []).append(int(rest))
                name = None
                continue
            result[name] = []
        elif name:
            result[name].append(line)
    return result


def without(lines, removed):
    remaining = list(lines)
    for line in removed:
        remaining.remove(line)
    return remaining


def split_state(lines):
    first, second = (index for index, line in enumerate(lines) if line == '---')
    return lines[:first], lines[first + 1:second], lines[second + 1:]


@unittest.skipUnless(shutil.which('docker'), 'Docker is required for the real-iptables repair tests')
class FirewallRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        present = subprocess.run(['docker', 'image', 'inspect', IMAGE], capture_output=True)
        if present.returncode:
            subprocess.run(['docker', 'build', '-q', '-t', IMAGE, '-'], input=DOCKERFILE.encode(), check=True,
                           capture_output=True, timeout=900)

    def repair(self, *, hostname='congvc-c00', net=None, prod=None, prod_after=None, name='congvc-c00',
               backend='iptables', forward=FORWARD, fault_write=0, fault_mode='none', extra='', helper=False):
        env = {
            'NETWORK_JSON': json.dumps(net or network()), 'PROD_JSON': json.dumps(prod or production()),
            'PROD_AFTER_JSON': json.dumps(prod_after or prod or production()), 'DOCKER_NAME': name,
            'DOCKER_BACKEND': backend, 'BASELINE_FORWARD': forward, 'FAULT_WRITE': str(fault_write),
            'FAULT_MODE': fault_mode, 'EXTRA_SETUP': extra, 'RUN_HELPER': '1' if helper else '',
        }
        command = ['docker', 'run', '--rm', '-i', '--network', 'none', '--cap-add', 'NET_ADMIN',
                   '--hostname', hostname, '-v', f'{OPS}:/ops:ro']
        for key in env:
            command += ['-e', key]
        command += [IMAGE, 'bash', '-s']
        completed = subprocess.run(command, input=HARNESS, env={**env, 'PATH': '/usr/bin:/bin'},
                                   capture_output=True, text=True, timeout=180)
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        return sections(completed.stdout)

    def assert_unchanged(self, result, message):
        output = '\n'.join(result['OUT'] + result['ERR'])
        self.assertEqual(result['CODES'][0], 1, output)
        self.assertIn('MISMATCH', output)
        self.assertIn(message, output)
        self.assertNotIn('MANUAL RECOVERY', output)
        self.assertNotIn('MATCH: adopted', output)
        self.assertEqual(result['AFTER'], result['BEFORE'], output)
        self.assertEqual(split_state(result['AFTER'])[2], [])

    def test_applies_exact_rules_and_verified_read_only_helper_view(self):
        result = self.repair(helper=True)
        output = '\n'.join(result['OUT'] + result['ERR'])
        self.assertEqual(result['CODES'][0], 0, output)
        self.assertIn('MATCH: adopted network ' + NET_ID, output)
        before4, before6, _ = split_state(result['BEFORE'])
        after4, after6, sudoers = split_state(result['AFTER'])
        self.assertEqual(without(after4, ADDED_V4), before4)
        self.assertEqual(without(after6, ADDED_V6), before6)
        self.assertEqual(sudoers, ['che-828-staging-firewall-readonly'])
        for chain, hook in (('INPUT', ADDED_V4[2]), ('FORWARD', ADDED_V4[3]), ('DOCKER-USER', ADDED_V4[4])):
            self.assertEqual(next(line for line in after4 if line.startswith(f'-A {chain} ')), hook)
        for chain, deny in (('INPUT', ADDED_V6[0]), ('FORWARD', ADDED_V6[1])):
            self.assertEqual(next(line for line in after6 if line.startswith(f'-A {chain} ')), deny)
        helper = result['HELPER']
        self.assertEqual(helper[:2], ['firewall isolation MATCH', 'helper=0'])
        self.assertEqual(helper[2], '0:0:440')
        self.assertIn('congvc ALL=(root) NOPASSWD: CHE828_FIREWALL_READ', helper)
        self.assertEqual(helper[-3:], ['flush=1', 'delete=1', 'read=0'])
        # A second run must refuse the now-present state and leave it intact.
        self.assertEqual(result['CODES'][1], 1)
        self.assertIn('MISMATCH', '\n'.join(result['RERUN']))
        self.assertEqual(result['AFTER-RERUN'], result['AFTER'])

    def test_preflight_mismatch_changes_nothing(self):
        busy = network(Containers={'abc': {'Name': 'x'}})
        masquerading = network()
        masquerading[0]['Options'] = {**masquerading[0]['Options'],
                                      'com.docker.network.bridge.enable_ip_masquerade': 'true'}
        two_networks = production()
        two_networks[0]['NetworkSettings']['Networks']['other'] = {'IPAddress': '172.30.0.2'}
        cases = {
            'wrong host': dict(hostname='congvc-x99'),
            'wrong Docker daemon': dict(name='other'),
            'firewall backend is not iptables': dict(backend='nftables'),
            'staging network identity changed': dict(net=network(Id='0' * 64)),
            'staging network is not empty': dict(net=busy),
            'staging network configuration changed': dict(net=masquerading),
            'production identity changed': dict(prod=production(Id='1' * 64)),
            'production is not running healthy': dict(prod=production(State={'Running': True, 'Health': {'Status': 'unhealthy'}})),
            'production network set changed': dict(prod=two_networks),
            'IPv4 FORWARD order changed at rule 1': dict(forward=OLD_FORWARD),
            'DOCKER-USER is no longer empty': dict(extra='iptables -A DOCKER-USER -j RETURN'),
            'ACTUAL_STAGING_INPUT already exists': dict(extra='iptables -N ACTUAL_STAGING_INPUT'),
            'pre-existing staging rule in INPUT': dict(extra='iptables -A INPUT -i act-stg0 -j ACCEPT'),
            'pre-existing IPv6 staging rule in FORWARD': dict(extra='ip6tables -A FORWARD -i act-stg0 -j DROP'),
            'helper sudoers view already exists': dict(extra=f'touch {SUDOERS}'),
            'bridge device absent': dict(extra='ip link del act-stg0'),
        }
        for message, options in cases.items():
            with self.subTest(message=message):
                result = self.repair(**options)
                if message == 'helper sudoers view already exists':
                    output = '\n'.join(result['OUT'] + result['ERR'])
                    self.assertEqual(result['CODES'][0], 1, output)
                    self.assertIn(message, output)
                    self.assertEqual(result['AFTER'], result['BEFORE'])
                else:
                    self.assert_unchanged(result, message)

    def assert_unclaimed_kept(self, result, left4, left6):
        output = '\n'.join(result['OUT'] + result['ERR'])
        self.assertEqual(result['CODES'][0], 1, output)
        self.assertIn('MANUAL RECOVERY REQUIRED', output)
        self.assertNotIn('MATCH: adopted', output)
        before4, before6, _ = split_state(result['BEFORE'])
        after4, after6, sudoers = split_state(result['AFTER'])
        self.assertEqual(without(after4, left4), before4, output)
        self.assertEqual(without(after6, left6), before6, output)
        self.assertEqual(sudoers, [])

    def test_failure_at_every_firewall_write_rolls_back_exactly(self):
        for write in range(1, WRITES + 1):
            with self.subTest(write=write):
                self.assert_unchanged(self.repair(fault_write=write, fault_mode='fail'),
                                      'removing exactly this invocation')

    def test_write_applied_but_failed_is_never_claimed(self):
        for write in range(1, WRITES + 1):
            with self.subTest(write=write):
                result = self.repair(fault_write=write, fault_mode='fail-after')
                if write in UNCLAIMED:
                    self.assert_unclaimed_kept(result, *UNCLAIMED[write])
                else:
                    self.assert_unchanged(result, 'removing exactly this invocation')

    def test_chain_created_concurrently_after_preflight_is_kept(self):
        for write in (1, 2):
            with self.subTest(write=write):
                result = self.repair(fault_write=write, fault_mode='race')
                self.assertIn('Chain already exists', '\n'.join(result['ERR']))
                self.assert_unclaimed_kept(result, *UNCLAIMED[write])

    def test_sudoers_view_created_concurrently_is_kept(self):
        result = self.repair(fault_mode='race-sudoers')
        output = '\n'.join(result['OUT'] + result['ERR'])
        self.assertEqual(result['CODES'][0], 1, output)
        self.assertNotIn('MATCH: adopted', output)
        before4, before6, _ = split_state(result['BEFORE'])
        after4, after6, sudoers = split_state(result['AFTER'])
        self.assertEqual((after4, after6), (before4, before6), output)
        self.assertEqual(sudoers, ['che-828-staging-firewall-readonly'])

    def test_sigterm_during_apply_rolls_back_exactly(self):
        for write in (1, 2, 3, 8, 9, WRITES):
            for mode in ('term', 'term-after'):
                with self.subTest(write=write, mode=mode):
                    self.assert_unchanged(self.repair(fault_write=write, fault_mode=mode), 'removing exactly')

    def test_readback_failures_roll_back_rules_and_sudoers(self):
        drifted = production(Id='2' * 64)
        cases = {
            'sudoers view syntax': dict(fault_mode='visudo'),
            'helper cannot read': dict(fault_mode='runuser'),
            'network or production identity drift': dict(prod_after=drifted),
        }
        for message, options in cases.items():
            with self.subTest(message=message):
                self.assert_unchanged(self.repair(**options), message)

    def test_rollback_failure_is_reported_for_manual_recovery(self):
        result = self.repair(fault_write=WRITES, fault_mode='delete')
        output = '\n'.join(result['OUT'] + result['ERR'])
        self.assertEqual(result['CODES'][0], 1)
        self.assertIn('ROLLBACK-FAILED', output)
        self.assertIn('MANUAL RECOVERY REQUIRED', output)


if __name__ == '__main__':
    unittest.main()
