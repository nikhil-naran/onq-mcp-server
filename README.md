# OnQ MCP server for ChatGPT

This repository contains the OnQ MCP server for Queen's courses. It runs on a Windows desktop and connects to ChatGPT through [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Queen's sign-in and MFA happen in a local browser. The supplied setup disables LMS write tools.

**Windows agent: start with [the handoff](docs/onq/WINDOWS-HANDOFF.md), then follow [the full setup guide](docs/onq/SETUP.md).**

**Already running the older server on Windows? Follow [the update guide](docs/onq/UPDATE-WINDOWS.md).** Stop the tunnel before updating, then compare course data with the OnQ website after restarting it.

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

This branch is the maintained Windows and ChatGPT version of the OnQ server. It began from Brightspace MCP v1.3.1; the license retains that attribution. Automated tests run locally, while Queen's tenant responses require live checks in the Windows session.

## Repository notes

- [ONQ-README.md](ONQ-README.md): features and project scope
- [docs/onq/DESIGN.md](docs/onq/DESIGN.md): adaptation design
- [LICENSE](LICENSE): MIT license and attribution

The older `master` branch in this GitHub repository contains an earlier, separate OnQ implementation. Use `codex/onq-windows` for this Windows and ChatGPT setup.
