# Sourced by every bash in the Ledger dev container (~/.bashrc). VS Code
# saves its Git extension's terminal variables in the window's state on the
# Mac and adds them to each new terminal, even with the extension off and
# its socket gone. Clear them, and any forwarded agent, so nothing in the
# container reaches the Mac's Git sign-in or GPG agent (sandbox:check).
unset GIT_ASKPASS VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_EXTRA_ARGS GPG_AGENT_INFO SSH_AUTH_SOCK
