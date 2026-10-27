#!/bin/sh
# npm run sandbox:check (steer of 26 Oct 2026, S8.7). Prints "Sandbox OK" only
# when every part of the dev container's fence holds.
fail=0
no() { echo "NOT OK: $1"; fail=1; }
[ -f /etc/ledger-sandbox ] || no "no sandbox marker (/etc/ledger-sandbox): this is not the Ledger dev container"
[ "${LEDGER_SANDBOX:-}" = devcontainer ] || no "LEDGER_SANDBOX is not devcontainer"
[ -z "${SSH_AUTH_SOCK:-}" ] || no "an SSH agent is forwarded (SSH_AUTH_SOCK=$SSH_AUTH_SOCK)"
ls /tmp/vscode-ssh-auth-* >/dev/null 2>&1 && no "VS Code forwarded an SSH agent socket"
[ -S /var/run/docker.sock ] && no "the Docker socket is inside the container"
grep -E ' (/Users|/Volumes|/run/host_mark)' /proc/mounts >/dev/null 2>&1 && no "a Mac folder is mounted"
grep -E 'virtiofs|fakeowner|grpcfuse|osxfs' /proc/mounts | grep -v ' /etc/' >/dev/null 2>&1 && no "a host folder is shared into the container"
git config --get-all credential.helper 2>/dev/null | grep -qi vscode && no "VS Code passes your Mac's Git sign-in into the container (setup step 6)"
[ -z "${GIT_ASKPASS:-}" ] || no "VS Code passes your Mac's Git sign-in through GIT_ASKPASS ($GIT_ASKPASS)"
[ -z "${VSCODE_GIT_IPC_HANDLE:-}" ] || no "VS Code's Git sign-in channel is open (VSCODE_GIT_IPC_HANDLE=$VSCODE_GIT_IPC_HANDLE)"
ls /tmp/vscode-git-*.sock >/dev/null 2>&1 && no "VS Code forwarded a Git sign-in socket (/tmp/vscode-git-*.sock)"
[ -z "${GPG_AGENT_INFO:-}" ] || no "a GPG agent is forwarded (GPG_AGENT_INFO=$GPG_AGENT_INFO)"
for f in /tmp/vscode-gpg-* "$HOME"/.gnupg/S.gpg-agent* /run/user/*/gnupg/S.gpg-agent*; do
  [ -e "$f" ] && { no "VS Code forwarded your Mac's GPG agent ($f)"; break; }
done
[ -d "$HOME/.ssh" ] && [ -n "$(ls -A "$HOME/.ssh" 2>/dev/null)" ] && no "~/.ssh holds keys"
curl -s --connect-timeout 5 https://example.com >/dev/null 2>&1 && no "the firewall lets https://example.com through"
curl -s --connect-timeout 5 https://api.supabase.com >/dev/null 2>&1 && no "the firewall lets a production host through"
curl -s --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1 || no "GitHub is unreachable"
[ "${PYTHONSAFEPATH:-}" = 1 ] || no "PYTHONSAFEPATH is not 1"
[ "$(git config core.hooksPath)" = .githooks ] || no "the commit hook is not on (git config core.hooksPath .githooks)"
if [ "$fail" = 0 ]; then echo "Sandbox OK"; else exit 1; fi
