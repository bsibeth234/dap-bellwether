# The Ledger dev container (steer of 26 Oct 2026, S8). Based on Anthropic's
# reference Claude Code dev container (anthropics/claude-code, .devcontainer,
# read 26 Oct 2026), cut down: no zsh theme, no git-delta, nothing downloaded
# from outside the Debian and npm registries. The repo lives in a Docker
# volume (VS Code: "Clone Repository in Container Volume"), never a Mac
# folder. No Docker inside: nothing here needs the Docker socket or
# privileged mode. Same container as dap-bye-saas.
#
# Pinned to an exact Node release. The image digest is pinned once Brendan's
# first build records it (docker images --digests); see STATUS.md.
FROM node:22.23.4-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.296

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git gh less procps sudo \
    iptables ipset iproute2 dnsutils aggregate jq \
    python3 python3-jsonschema \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The marker the sandbox lock looks for (scripts/require-sandbox.sh).
RUN printf 'Ledger dev container\n' > /etc/ledger-sandbox && chmod 0444 /etc/ledger-sandbox

ENV LEDGER_SANDBOX=devcontainer \
    PYTHONSAFEPATH=1 \
    DEVCONTAINER=true \
    DISABLE_AUTOUPDATER=1

# Claude Code, one exact version at least 14 days old (S10). No self-update.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

RUN mkdir -p /commandhistory /home/node/.claude /home/node/.config/gh /workspaces \
  && chown -R node:node /commandhistory /home/node/.claude /home/node/.config /workspaces

COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod 0755 /usr/local/bin/init-firewall.sh \
  && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-ledger \
  && chmod 0440 /etc/sudoers.d/node-ledger

COPY clear-forwarding.sh /etc/ledger-clear-forwarding.sh
RUN chmod 0444 /etc/ledger-clear-forwarding.sh \
  && printf '\n. /etc/ledger-clear-forwarding.sh\n' >> /home/node/.bashrc

USER node
WORKDIR /workspaces
