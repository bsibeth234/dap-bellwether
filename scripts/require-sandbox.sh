#!/bin/sh
# The sandbox lock (steer of 26 Oct 2026, S7, D-45). Ledger code runs only in
# the Anthropic cloud (the routine and review sessions), a CI build, or the
# Ledger dev container. Same lock as dap-bye-saas (D-45). Anywhere else this exits 2 and says why.
# It stops accidents and a steered agent; it cannot stop a person who sets
# these variables by hand.
marker="${LEDGER_SANDBOX_MARKER:-/etc/ledger-sandbox}"
if [ "${GITHUB_ACTIONS:-}" = true ] || [ "${VERCEL:-}" = 1 ] || [ "${WORKERS_CI:-}" = 1 ]; then exit 0; fi
if [ "${CLAUDE_CODE_REMOTE:-}" = true ] || [ "${LEDGER_SANDBOX:-}" = cloud ]; then exit 0; fi
if [ "${LEDGER_SANDBOX:-}" = devcontainer ] && [ -f "$marker" ]; then exit 0; fi
echo "Ledger runs only in the sandbox: the dev container, the cloud, or CI. Open this repo from VS Code, Remote Explorer, Dev Volumes. See bsibeth234/dap-bye-saas docs/STEER_2026-10-26-untrusted-content.md." >&2
exit 2
