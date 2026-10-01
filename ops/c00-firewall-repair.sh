#!/usr/bin/env bash
# CHE-828 one-shot staging-only C00 firewall repair (Cheese approval
# 01a0f1ae-063b-7b8f-bd77-df68fd0f3dce; scope 01a0f1ae-e704-7dad-844a-967611150979).
# Adopts the existing empty actual-staging-isolated network; never creates,
# changes or removes it. Restores only the reviewed act-stg0 IPv4 hooks/chains
# and IPv6 denials, installs an exact-argument read-only sudoers view for the
# helper, reads everything back, and removes exactly its own changes on any
# mismatch. Not persistent: a reboot or firewall reload drops the rules and the
# helper then fails closed. Root on C00 only, after independent review.
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin
NET=actual-staging-isolated
NET_ID=b2773bc7d6fad77f6df3a3c60a5ab8efe221822aca778baf954a5559e029c732
BR=act-stg0
SUBNET=172.31.254.0/24
GATEWAY=172.31.254.1
PROD=actual-budget
PROD_ID=397a9eda92489b77480aed31c86127fb91420d6648c7a4880a9f67f5c1a23b8e
PROD_IMAGE=sha256:1c14eef351234f4b5dd0433865b5de89d70bdbdc57368d5b07e910662c6498f9
PROD_NET=actual-budget_default
HELPER_USER=congvc
IPT=/usr/sbin/iptables
IP6T=/usr/sbin/ip6tables
INPUT_CHAIN=ACTUAL_STAGING_INPUT
FORWARD_CHAIN=ACTUAL_STAGING_FORWARD
SUDOERS=/etc/sudoers.d/che-828-staging-firewall-readonly
# Exactly the reads the helper performs; sudoers matches these argv verbatim.
READS=(
  "$IPT -w -S INPUT" "$IPT -w -S FORWARD" "$IPT -w -S DOCKER-USER"
  "$IPT -w -S $INPUT_CHAIN" "$IPT -w -S $FORWARD_CHAIN"
  "$IP6T -w -S INPUT" "$IP6T -w -S FORWARD"
)
EXPECTED_FORWARD=(
  '-A FORWARD -j DOCKER-USER'
  '-A FORWARD -j DOCKER-FORWARD'
  '-A FORWARD -j ts-forward'
  '-A FORWARD -j ufw-before-logging-forward'
  '-A FORWARD -j ufw-before-forward'
)

[[ $(id -u) == 0 ]] || { printf 'MISMATCH: root required\n'; exit 1; }
[[ $(hostname -s) == congvc-c00 ]] || { printf 'MISMATCH: wrong host\n'; exit 1; }
for tool in docker python3 flock visudo runuser sudo sha256sum mktemp; do
  command -v "$tool" >/dev/null || { printf 'MISMATCH: missing %s\n' "$tool"; exit 1; }
done
[[ -x $IPT && -x $IP6T ]] || { printf 'MISMATCH: missing iptables binaries\n'; exit 1; }
id -u "$HELPER_USER" >/dev/null || { printf 'MISMATCH: helper user missing\n'; exit 1; }
trap 'printf "MISMATCH: preflight command failed at line %s; no changes made\n" "$LINENO" >&2' ERR
exec 9>/run/lock/che-828-staging-firewall.lock
flock -n 9 || { printf 'MISMATCH: another CHE-828 apply is running\n'; exit 1; }

# Prints the production IPv4 address, or MISMATCH and nonzero.
identity() {
  local network production
  network=$(docker network inspect "$NET") || { printf 'MISMATCH: network inspection failed\n'; return 1; }
  production=$(docker inspect "$PROD") || { printf 'MISMATCH: production inspection failed\n'; return 1; }
  python3 - "$NET_ID" "$BR" "$SUBNET" "$GATEWAY" "$PROD_ID" "$PROD_IMAGE" "$PROD_NET" "$network" "$production" <<'PY'
import ipaddress, json, sys
net_id, bridge, subnet, gateway, prod_id, prod_image, prod_net, network_json, prod_json = sys.argv[1:]
def fail(message):
    print(f'MISMATCH: {message}')
    sys.exit(1)
networks, productions = json.loads(network_json), json.loads(prod_json)
if len(networks) != 1 or len(productions) != 1:
    fail('inspection returned unexpected objects')
network, production = networks[0], productions[0]
options = network.get('Options') or {}
config = (network.get('IPAM') or {}).get('Config') or []
if network.get('Id') != net_id:
    fail('staging network identity changed')
if (network.get('Driver') != 'bridge' or network.get('Internal') is not True
        or network.get('EnableIPv6') is not False
        or options.get('com.docker.network.bridge.name') != bridge
        or options.get('com.docker.network.bridge.enable_ip_masquerade') != 'false'
        or len(config) != 1 or config[0].get('Subnet') != subnet or config[0].get('Gateway') != gateway):
    fail('staging network configuration changed')
if network.get('Containers'):
    fail('staging network is not empty')
state = production.get('State') or {}
attached = (production.get('NetworkSettings') or {}).get('Networks') or {}
if production.get('Id') != prod_id or production.get('Image') != prod_image:
    fail('production identity changed')
if state.get('Running') is not True or (state.get('Health') or {}).get('Status', 'healthy') != 'healthy':
    fail('production is not running healthy')
if set(attached) != {prod_net}:
    fail('production network set changed')
try:
    address = ipaddress.ip_address(attached[prod_net].get('IPAddress') or '')
except ValueError:
    fail('production IP invalid')
if address.version != 4 or address in ipaddress.ip_network(subnet):
    fail('production IP invalid or overlaps staging subnet')
print(address)
PY
}

# Read-only preflight: exact Docker, network, production and firewall baseline.
[[ $(docker info --format '{{.Name}}') == congvc-c00 ]] || { printf 'MISMATCH: wrong Docker daemon\n'; exit 1; }
[[ $(docker info --format '{{.FirewallBackend.Driver}}') == iptables ]] || { printf 'MISMATCH: Docker firewall backend is not iptables\n'; exit 1; }
PROD_IP=$(identity) || { printf '%s\n' "$PROD_IP"; exit 1; }
[[ -e /sys/class/net/$BR ]] || { printf 'MISMATCH: bridge device absent\n'; exit 1; }
mapfile -t forward_prefix < <("$IPT" -w -S FORWARD | grep -- '^-A FORWARD ' | sed -n '1,5p')
[[ ${#forward_prefix[@]} == 5 ]] || { printf 'MISMATCH: IPv4 FORWARD prefix length changed\n'; exit 1; }
for i in 0 1 2 3 4; do
  [[ ${forward_prefix[i]} == "${EXPECTED_FORWARD[i]}" ]] || { printf 'MISMATCH: IPv4 FORWARD order changed at rule %s\n' "$((i+1))"; exit 1; }
done
[[ $("$IPT" -w -S DOCKER-USER) == '-N DOCKER-USER' ]] || { printf 'MISMATCH: DOCKER-USER is no longer empty\n'; exit 1; }
for chain in "$INPUT_CHAIN" "$FORWARD_CHAIN"; do
  if "$IPT" -w -S "$chain" >/dev/null 2>&1; then printf 'MISMATCH: %s already exists; do not adopt partial state\n' "$chain"; exit 1; fi
done
staging_token="(^|[[:space:]])($BR|$INPUT_CHAIN|$FORWARD_CHAIN)([[:space:]]|$)"
for chain in INPUT FORWARD DOCKER-USER; do
  if "$IPT" -w -S "$chain" | grep -E -- "$staging_token" >/dev/null; then printf 'MISMATCH: pre-existing staging rule in %s\n' "$chain"; exit 1; fi
done
for chain in INPUT FORWARD; do
  if "$IP6T" -w -S "$chain" | grep -E -- "$staging_token" >/dev/null; then printf 'MISMATCH: pre-existing IPv6 staging rule in %s\n' "$chain"; exit 1; fi
done
[[ ! -e $SUDOERS && ! -L $SUDOERS ]] || { printf 'MISMATCH: helper sudoers view already exists\n'; exit 1; }
for chain in INPUT FORWARD DOCKER-USER; do
  printf 'BEFORE iptables %s sha256: %s\n' "$chain" "$("$IPT" -w -S "$chain" | sha256sum | cut -d' ' -f1)"
  "$IPT" -w -S "$chain"
done
for chain in INPUT FORWARD; do
  printf 'BEFORE ip6tables %s sha256: %s\n' "$chain" "$("$IP6T" -w -S "$chain" | sha256sum | cut -d' ' -f1)"
  "$IP6T" -w -S "$chain"
done
printf 'BEFORE network=%s bridge=%s containers=0; prod_id=%s prod_ip=%s\n' "$NET_ID" "$BR" "$PROD_ID" "$PROD_IP"

# Track each mutation before making it. Roll back only this invocation's objects.
created_input=0
created_forward=0
created_sudoers=0
sudoers_tmp=
added=()
rollback() {
  local i family chain spec rules failed=0
  set +e
  [[ -n $sudoers_tmp ]] && rm -f -- "$sudoers_tmp"
  if ((created_sudoers)) && [[ -e $SUDOERS ]]; then
    if [[ $(sha256sum < "$SUDOERS" | cut -d' ' -f1) == "$sudoers_sha" ]]; then
      rm -f -- "$SUDOERS" || { printf 'ROLLBACK-FAILED: sudoers view\n' >&2; failed=1; }
    else
      printf 'ROLLBACK-FAILED: sudoers view changed; refusing removal\n' >&2; failed=1
    fi
  fi
  for ((i=${#added[@]}-1; i>=0; i--)); do
    IFS='|' read -r family chain spec <<< "${added[i]}"
    read -r -a args <<< "$spec"
    if ! rules=$("$family" -w -S "$chain"); then
      printf 'ROLLBACK-FAILED: cannot inspect %s %s\n' "$family" "$chain" >&2; failed=1; continue
    fi
    # -S canonicalizes conntrack state order; -C uses kernel matching.
    if "$family" -w -C "$chain" "${args[@]}" >/dev/null 2>&1; then
      "$family" -w -D "$chain" "${args[@]}" || { printf 'ROLLBACK-FAILED: %s -D %s %s\n' "$family" "$chain" "$spec" >&2; failed=1; }
    elif [[ $chain == "$INPUT_CHAIN" || $chain == "$FORWARD_CHAIN" ]] && [[ $rules == *"-A $chain "* ]]; then
      printf 'ROLLBACK-FAILED: cannot prove %s %s rule absent\n' "$family" "$chain" >&2; failed=1
    fi
  done
  if ((created_forward)); then "$IPT" -w -X "$FORWARD_CHAIN" || { printf 'ROLLBACK-FAILED: forward chain\n' >&2; failed=1; }; fi
  if ((created_input)); then "$IPT" -w -X "$INPUT_CHAIN" || { printf 'ROLLBACK-FAILED: input chain\n' >&2; failed=1; }; fi
  if ((failed)); then printf 'MANUAL RECOVERY REQUIRED: at least one staging-only object remains; do not run staging\n' >&2; fi
}
fail() {
  # ERR is inherited by command substitutions; only the main shell rolls back.
  [[ $BASHPID == "$$" ]] || exit 1
  trap - ERR HUP INT TERM; printf 'MISMATCH: %s; removing exactly this invocation\n' "$1" >&2; rollback; exit 1
}
trap 'fail "apply/readback interrupted at line $LINENO"' ERR
trap 'fail "interrupted"' HUP INT TERM
add() {
  local family=$1 chain=$2; shift 2
  # Register first so an interruption right after the insert cannot orphan it.
  added+=("$family|$chain|$*")
  "$family" -w -I "$chain" 1 "$@"
}
created_input=1
"$IPT" -w -N "$INPUT_CHAIN"
created_forward=1
"$IPT" -w -N "$FORWARD_CHAIN"
# Reverse insertion order: established replies, exact gateway/production
# denials, then deny all other staging-origin traffic.
add "$IPT" "$INPUT_CHAIN" -j DROP
add "$IPT" "$INPUT_CHAIN" -s "$SUBNET" -d "$GATEWAY/32" -j DROP
add "$IPT" "$INPUT_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
add "$IPT" "$FORWARD_CHAIN" -j DROP
add "$IPT" "$FORWARD_CHAIN" -s "$SUBNET" -d "$PROD_IP/32" -j DROP
add "$IPT" "$FORWARD_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
add "$IPT" INPUT -i "$BR" -j "$INPUT_CHAIN"
add "$IPT" DOCKER-USER -i "$BR" -j "$FORWARD_CHAIN"
# ts-forward accepts tailnet egress; the position-one FORWARD hook is the
# effective deny and DOCKER-USER remains defense in depth.
add "$IPT" FORWARD -i "$BR" -j "$FORWARD_CHAIN"
add "$IP6T" INPUT -i "$BR" -j DROP
add "$IP6T" FORWARD -i "$BR" -j DROP

# Read-only helper view: exact argv only, no password, no environment passing.
sudoers_body="# CHE-828 staging helper read-only firewall view; approval 01a0f1ae-063b-7b8f-bd77-df68fd0f3dce
Cmnd_Alias CHE828_FIREWALL_READ = $(IFS=,; printf '%s' "${READS[*]}" | sed 's/,/, /g')
Defaults!CHE828_FIREWALL_READ env_reset
$HELPER_USER ALL=(root) NOPASSWD: CHE828_FIREWALL_READ"
sudoers_sha=$(printf '%s\n' "$sudoers_body" | sha256sum | cut -d' ' -f1)
# sudo ignores includedir names containing '.', so the temp file is inert.
sudoers_tmp=$(mktemp /etc/sudoers.d/.che-828.XXXXXX)
printf '%s\n' "$sudoers_body" > "$sudoers_tmp"
chown root:root "$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
visudo -cqf "$sudoers_tmp" || fail 'sudoers view syntax'
created_sudoers=1
mv -nT -- "$sudoers_tmp" "$SUDOERS"
sudoers_tmp=
visudo -cq || fail 'sudo configuration check'

# Readback of live rules, identity and helper view.
[[ $(identity) == "$PROD_IP" ]] || fail 'network or production identity drift'
[[ $(docker info --format '{{.FirewallBackend.Driver}}') == iptables ]] || fail 'Docker backend drift'
mapfile -t after_prefix < <("$IPT" -w -S FORWARD | grep -- '^-A FORWARD ' | sed -n '1,6p')
[[ ${#after_prefix[@]} == 6 && ${after_prefix[0]} == "-A FORWARD -i $BR -j $FORWARD_CHAIN" ]] || fail 'IPv4 staging FORWARD hook is not first'
for i in 0 1 2 3 4; do
  [[ ${after_prefix[i+1]} == "${EXPECTED_FORWARD[i]}" ]] || fail 'IPv4 FORWARD baseline order drift'
done
for entry in "${added[@]}"; do
  IFS='|' read -r family chain spec <<< "$entry"
  read -r -a args <<< "$spec"
  "$family" -w -C "$chain" "${args[@]}" || fail "missing $family $chain rule"
done
[[ $("$IPT" -w -S "$INPUT_CHAIN") == "-N $INPUT_CHAIN
-A $INPUT_CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A $INPUT_CHAIN -s $SUBNET -d $GATEWAY/32 -j DROP
-A $INPUT_CHAIN -j DROP" ]] || fail 'input chain content'
[[ $("$IPT" -w -S "$FORWARD_CHAIN") == "-N $FORWARD_CHAIN
-A $FORWARD_CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A $FORWARD_CHAIN -s $SUBNET -d $PROD_IP/32 -j DROP
-A $FORWARD_CHAIN -j DROP" ]] || fail 'forward chain content'
[[ $("$IPT" -w -S DOCKER-USER) == "-N DOCKER-USER
-A DOCKER-USER -i $BR -j $FORWARD_CHAIN" ]] || fail 'DOCKER-USER content'
[[ $("$IPT" -w -S INPUT | grep -- '^-A ' | sed -n '1p') == "-A INPUT -i $BR -j $INPUT_CHAIN" ]] || fail 'INPUT hook precedence'
[[ $("$IPT" -w -S INPUT | grep -cE -- "$staging_token") == 1 ]] || fail 'INPUT hook count'
[[ $("$IPT" -w -S FORWARD | grep -cE -- "$staging_token") == 1 ]] || fail 'FORWARD hook count'
for chain in INPUT FORWARD; do
  [[ $("$IP6T" -w -S "$chain" | grep -- '^-A ' | sed -n '1p') == "-A $chain -i $BR -j DROP" ]] || fail "IPv6 $chain precedence"
  [[ $("$IP6T" -w -S "$chain" | grep -cE -- "$staging_token") == 1 ]] || fail "IPv6 $chain deny count"
done
[[ $(stat -c '%u:%g:%a' "$SUDOERS") == 0:0:440 && $(sha256sum < "$SUDOERS" | cut -d' ' -f1) == "$sudoers_sha" ]] || fail 'sudoers view readback'
for read_cmd in "${READS[@]}"; do
  read -r -a args <<< "$read_cmd"
  expected=$("${args[@]}")
  actual=$(runuser -u "$HELPER_USER" -- sudo -n "${args[@]}" 2>/dev/null) || fail "helper cannot read: $read_cmd"
  [[ $actual == "$expected" ]] || fail "helper view differs: $read_cmd"
done
# Negative controls: non-exact argv is refused without a password. Only
# read-only commands are executed here; write denial rests on the same exact
# argv matching and on the verified sudoers bytes above.
for denied in "$IPT -w -S" "$IPT -S INPUT" "$IPT -w -L INPUT" "$IPT -w -t nat -S" "$IPT -w -S INPUT -v" "$IP6T -w -S"; do
  read -r -a args <<< "$denied"
  if runuser -u "$HELPER_USER" -- sudo -n "${args[@]}" >/dev/null 2>&1; then fail "helper view allows: $denied"; fi
done

printf 'AFTER iptables INPUT, FORWARD and DOCKER-USER first rules:\n'
for chain in INPUT FORWARD DOCKER-USER; do "$IPT" -w -S "$chain" | grep -- '^-A ' | sed -n '1p'; done
printf 'AFTER iptables staging-only chains:\n'
"$IPT" -w -S "$INPUT_CHAIN"
"$IPT" -w -S "$FORWARD_CHAIN"
printf 'AFTER ip6tables INPUT and FORWARD first rules:\n'
for chain in INPUT FORWARD; do "$IP6T" -w -S "$chain" | grep -- '^-A ' | sed -n '1p'; done
printf 'AFTER helper sudoers view %s sha256: %s\n' "$SUDOERS" "$sudoers_sha"
cat "$SUDOERS"
printf 'MATCH: adopted network %s (bridge %s, subnet %s, gateway %s), production IP %s; IPv6 INPUT/FORWARD DROP; helper read-only view verified\n' \
  "$NET_ID" "$BR" "$SUBNET" "$GATEWAY" "$PROD_IP"
printf 'ROLLBACK (only with no staging containers running; leaves the network in place):\n'
printf 'sudo rm %s\n' "$SUDOERS"
printf 'sudo %s -w -D FORWARD -i %s -j DROP\n' "$IP6T" "$BR"
printf 'sudo %s -w -D INPUT -i %s -j DROP\n' "$IP6T" "$BR"
printf 'sudo %s -w -D FORWARD -i %s -j %s\n' "$IPT" "$BR" "$FORWARD_CHAIN"
printf 'sudo %s -w -D DOCKER-USER -i %s -j %s\n' "$IPT" "$BR" "$FORWARD_CHAIN"
printf 'sudo %s -w -D INPUT -i %s -j %s\n' "$IPT" "$BR" "$INPUT_CHAIN"
printf 'sudo %s -w -F %s && sudo %s -w -X %s\n' "$IPT" "$FORWARD_CHAIN" "$IPT" "$FORWARD_CHAIN"
printf 'sudo %s -w -F %s && sudo %s -w -X %s\n' "$IPT" "$INPUT_CHAIN" "$IPT" "$INPUT_CHAIN"
trap - ERR HUP INT TERM
