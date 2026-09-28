# OnQ MCP server for ChatGPT

This is Nikhil's personal Windows adaptation of [JhostinAleck/brightspace-mcp](https://github.com/JhostinAleck/brightspace-mcp) for Queen's OnQ. It runs on an always-on Windows desktop and connects to ChatGPT through [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Queen's sign-in and MFA happen in a local browser. The supplied setup disables LMS write tools.

**Windows agent: start with [the handoff](docs/onq/WINDOWS-HANDOFF.md), then follow [the full setup guide](docs/onq/SETUP.md).**

## Get this source on Windows

Install Node.js 24 and Git, then in PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\OnQ | Out-Null
cd C:\OnQ
git clone --branch codex/onq-windows --single-branch https://github.com/nikhil-naran/onq-mcp-server.git onq-server
cd .\onq-server
.\scripts\windows\Setup-OnQ.ps1
.\scripts\windows\Login-OnQ.ps1
```

Complete the Queen's sign-in in the browser. Next, [configure the private tunnel](docs/onq/SETUP.md#2-configure-chatgpts-private-tunnel), test ChatGPT, and install the Windows startup task only after a successful manual test.

This source was [validated locally on macOS](docs/onq/VALIDATION.md). Windows execution, Queen's tenant access, and ChatGPT connection still need live verification. Do not treat a successful build as proof of those steps.

## Repository notes

- [ONQ-README.md](ONQ-README.md): features and project scope
- [docs/onq/DESIGN.md](docs/onq/DESIGN.md): adaptation design
- [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md): documentation retained from the Brightspace base
- [LICENSE](LICENSE): upstream MIT license

The older `master` branch in this GitHub repository contains an earlier, separate OnQ implementation. Use `codex/onq-windows` for this Windows and ChatGPT setup.
