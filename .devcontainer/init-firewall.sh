#!/bin/bash
# Ledger dev container firewall (steer of 26 Oct 2026, S8.4). Default deny.
# Adapted from Anthropic's reference init-firewall.sh, with three changes:
# no outbound SSH (GitHub is reached over HTTPS only), no blanket access to
# the Docker host's network (so nothing on the Mac is reachable, including
# Overture's databases), and DNS only to the container's own resolver.
# Production hosts (Supabase, Vercel, Cloudflare) are not on the list, so
# production is reachable only by a merge to main.
# Limit: the list is by IP address. A shared CDN address can carry other
# sites; the hosts below are the ones the work needs, and the check at the
# end proves an unlisted site and a production host are refused.
# A listed host that does not resolve is skipped with a warning, so one dead
# name cannot stop the container. The hosts the work cannot go without
# (REQUIRED_DOMAINS, and GitHub) still stop the script, so the firewall never
# comes up half-built.
set -euo pipefail
IFS=$'\n\t'

ALLOWED_DOMAINS=(
  # Claude Code
  api.anthropic.com
  claude.ai
  console.anthropic.com
  platform.claude.com
  sentry.io
  # Packages
  registry.npmjs.org
  pypi.org
  files.pythonhosted.org
  # VS Code server and the Claude Code extension
  update.code.visualstudio.com
  marketplace.visualstudio.com
  vscode.blob.core.windows.net
)
REQUIRED_DOMAINS=(api.anthropic.com)

DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)
iptables -F; iptables -X
iptables -t nat -F; iptables -t nat -X
iptables -t mangle -F; iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

if [ -n "$DOCKER_DNS_RULES" ]; then
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

# Localhost, and DNS to the resolvers named in /etc/resolv.conf only.
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
while read -r ns; do
  [[ "$ns" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || continue
  iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT
done < <(awk '$1 == "nameserver" {print $2}' /etc/resolv.conf)

ipset create allowed-domains hash:net

gh_ranges=$(curl -s --max-time 20 https://api.github.com/meta)
echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null || { echo "ERROR: GitHub meta missing ranges"; exit 1; }
while read -r cidr; do
  [[ "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo "ERROR: bad CIDR $cidr"; exit 1; }
  ipset add allowed-domains "$cidr" -exist
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

for domain in "${ALLOWED_DOMAINS[@]}"; do
  ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}' || true)
  if [ -z "$ips" ]; then
    for required in "${REQUIRED_DOMAINS[@]}"; do
      [ "$domain" != "$required" ] || { echo "ERROR: cannot resolve $domain"; exit 1; }
    done
    echo "WARNING: cannot resolve $domain, skipped"
    continue
  fi
  while read -r ip; do
    [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "ERROR: bad IP $ip for $domain"; exit 1; }
    ipset add allowed-domains "$ip" -exist
  done < <(echo "$ips")
done

iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p tcp --dport 443 -m set --match-set allowed-domains dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

refused() { ! curl -s --connect-timeout 5 "$1" >/dev/null 2>&1; }
refused https://example.com || { echo "ERROR: firewall let https://example.com through"; exit 1; }
refused https://api.supabase.com || { echo "ERROR: firewall let a production host through"; exit 1; }
refused https://api.cloudflare.com || { echo "ERROR: firewall let a production host through"; exit 1; }
curl -s --connect-timeout 5 https://api.github.com/zen >/dev/null || { echo "ERROR: GitHub unreachable"; exit 1; }
for required in "${REQUIRED_DOMAINS[@]}"; do
  curl -s --connect-timeout 5 "https://$required" >/dev/null || { echo "ERROR: $required unreachable"; exit 1; }
done
echo "Ledger firewall: default deny, $(ipset list allowed-domains | grep -c '^[0-9]') allowed ranges"
