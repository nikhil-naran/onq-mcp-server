# Windows agent handoff

This repository contains Nikhil's personal OnQ MCP server for ChatGPT. The Windows machine will run the server and OpenAI's private MCP tunnel. The Mac used to prepare this code does not need to stay on.

## Instructions for the Windows agent

1. Read [the full Windows setup guide](SETUP.md) and [the local validation record](VALIDATION.md). Work in this source checkout. Do not replace it with the published `brightspace-mcp` npm package or the older code on this repository's `master` branch.
2. Install Node.js 24 and clone the `codex/onq-windows` branch of `nikhil-naran/onq-mcp-server` to a permanent folder such as `C:\OnQ\onq-server`. Run PowerShell as Nikhil's normal Windows user, not as Administrator.
3. Run `.\scripts\windows\Setup-OnQ.ps1`, then `.\scripts\windows\Login-OnQ.ps1`. Allow Nikhil to complete Queen's sign-in and MFA in the browser. Report the exact step and error if either command fails. Never ask Nikhil to paste credentials, session cookies, or API keys into chat.
4. Verify local OnQ access before connecting ChatGPT. Compare the returned courses and one assignment against the OnQ website. Treat unavailable quiz, rubric, calendar, or completion data as a tenant capability to investigate, not as proof that the student has none.
5. Follow [the tunnel section](SETUP.md#2-configure-chatgpts-private-tunnel). Use the current [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to check account access and tunnel-client instructions. Keep the runtime key in the Windows user context through the supplied script. Do not put it in source files, shell history, or chat.
6. Test a course query and seven-day agenda in ChatGPT. Only after the foreground tunnel works, install the startup task. Verify it again after signing out and back in to Windows, and while the Mac is off.

The supplied configuration disables LMS write tools. Do not turn on assignment submission, discussion posting, quiz actions, or other OnQ writes during setup.

## Commands after cloning

```powershell
cd C:\OnQ\onq-server
.\scripts\windows\Setup-OnQ.ps1
.\scripts\windows\Login-OnQ.ps1
```

Then continue with [SETUP.md](SETUP.md). If PowerShell blocks a downloaded script, inspect the file, unblock only the reviewed project scripts as needed, and use the normal execution policy. Do not disable script protections system-wide.

## Completion report

Record the Node version, setup result, OnQ login result, a redacted example of a successful course read, tunnel readiness, ChatGPT tool discovery, startup task behavior, and any gaps. Do not include private course content or tokens in a public issue or commit.
