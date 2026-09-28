# OnQ for ChatGPT — Windows setup

This is Nikhil’s personal adaptation of [JhostinAleck/brightspace-mcp](https://github.com/JhostinAleck/brightspace-mcp), incorporating upstream v1.3.1. Keep the upstream MIT license. The Windows branch is `codex/onq-windows`. For an existing installation, follow [the update guide](UPDATE-WINDOWS.md).

## What is ready

Persistent interactive Queen’s sign-in, credential-file repair, rubric and completion tools, bounded PDF slide previews, an agenda with per-source warnings, and an optional filtered agenda component for ChatGPT. LMS submission/posting tools are disabled in this setup. Tools can still save documents to the server filesystem when explicitly requested.

## 1. Prepare Windows

Install Node.js 24 LTS. Copy/extract this project to a permanent location, for example `C:\OnQ\onq-server`. Do not copy macOS `node_modules`; Windows installs its own dependencies. Review the scripts before running them. If Windows blocks downloaded scripts, unblock the reviewed files and use your normal PowerShell execution policy; do not disable system-wide script protections.

Open PowerShell as your normal Windows user:

```powershell
cd C:\OnQ\onq-server
.\scripts\windows\Setup-OnQ.ps1
.\scripts\windows\Login-OnQ.ps1
```

Complete Queen’s SSO/MFA in the browser. The code does not fill your password or approve consent prompts. Chromium retains its browser profile under `%LOCALAPPDATA%\OnQMCP\browser`. That profile contains sensitive authentication state; Windows ACLs restrict the data directory to your account and SYSTEM. Configuration and course caches live alongside it. Keep one Queen’s account in this profile.

The login strategy first checks saved browser cookies without showing a window. When invalid, it opens a browser on Windows. There is a two-minute interactive window; if it times out, rerun Login-OnQ and retry ChatGPT. The configured one-hour cache duration is NOT a promise about Queen’s session lifetime.

## 2. Configure ChatGPT’s private tunnel

OpenAI’s [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) documents stdio connections and the current account requirements. You need a tunnel ID, Platform runtime API key, tunnel permissions, and developer-mode access in the target ChatGPT workspace. These are separate from your ChatGPT subscription. Availability and costs must be checked in your account.

Download the appropriate Windows binary from [OpenAI’s tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest), verify it against the release checksum, and put `tunnel-client.exe` on PATH. Windows amd64 and arm64 archives were listed during preparation. Do not use an unrelated public forwarding service.

Create a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) and associate it with the ChatGPT workspace you intend to use. Then:

```powershell
.\scripts\windows\Configure-Tunnel.ps1 -TunnelId tunnel_YOUR_ID
.\scripts\windows\Start-Tunnel.ps1
```

The setup prompts for the API key and stores it using Windows DPAPI via an encrypted SecureString. It can be decrypted only in the same Windows user/machine context. No key is written to the project or command arguments. The running tunnel receives it in its process environment. Move/rekey this setup explicitly if the Windows account changes.

In ChatGPT, enable developer mode in Settings → Security and login, open Plugins, add a connection, choose Tunnel, and select the associated tunnel. See [OpenAI’s connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). UI labels and availability may vary by account.

Ask: “List my OnQ courses.” Then: “Show my OnQ agenda for the next seven days.” `show_onq_agenda` supplies the optional visual component; ordinary tools also return readable data. Rendering in the actual ChatGPT host remains to be verified.

## 3. Start automatically after Windows login

After manual tunnel and ChatGPT tests pass, stop the foreground tunnel with Ctrl+C, then:

```powershell
.\scripts\windows\Install-StartupTask.ps1
Start-ScheduledTask -TaskName 'OnQ ChatGPT'
```

This is a task under your logged-in Windows account, not a headless system service. After a reboot you must sign into that account. Keep Windows awake and connected; this project does not change power settings. A locked session can continue ordinary requests, but you must unlock or remote into the desktop when Queen’s needs interactive MFA. Remote access must preserve the same Windows user/session.

The startup task retries a failed process up to ten times at one-minute intervals. It does not solve expired Queen’s sessions or monitor tunnel readiness. Check Task Scheduler and `tunnel-client doctor --profile onq --explain` when troubleshooting. Do not start a second tunnel while the task is running.

To renew login deliberately:

```powershell
Stop-ScheduledTask -TaskName 'OnQ ChatGPT'
.\scripts\windows\Login-OnQ.ps1
Start-ScheduledTask -TaskName 'OnQ ChatGPT'
```

Stop the task before deleting the private browser profile for logout. Revoking the ChatGPT connection and the Platform tunnel/key is a separate operation. To remove automatic startup use `Unregister-ScheduledTask -TaskName 'OnQ ChatGPT'`.

## Live acceptance checklist

For a complete lecture PDF, ChatGPT can use `list_my_courses` and `get_course_content` to locate a file topic or course file path, then call `get_original_pdf` with `course_id` and either `topic_id` or `path`. This read-only tool returns the original PDF bytes as an embedded MCP resource. It does not extract text, render pages, or save the PDF on the server. Confirm in the actual ChatGPT host that it can inspect a later page or diagram; a successful download alone does not prove this. On 2026-09-28, this was tested through the private OnQ tunnel with a later-page claim checked against OnQ's PDF viewer. Refresh the developer-mode connection after updating tools.

- Courses match OnQ, including expected active courses.
- Personal grades and quiz attempts are visible without staff permissions.
- One assignment’s instructions, attachments and rubric match OnQ.
- A visual lecture PDF returns the first five page images; remaining pages are clearly disclosed.
- Agenda displays Toronto-local times and distinguishes closing times from due dates.
- Denied quiz/calendar requests produce visible incomplete-coverage warnings.
- Completion access failure is shown as unknown, not unfinished.
- Reauthentication and Windows restart work as described.
- ChatGPT can call the tools while the Mac/laptop is off.
- No LMS write tools appear, and the visual component filters course rows correctly.

PDF downloads are limited to 25 MB; text is limited to 50 pages/60,000 characters and previews to five pages/6 MB. Off-origin download redirects are rejected so OnQ cookies cannot be forwarded to another host; some externally hosted course files may need to be opened directly. Rubric and completion API support varies by course/role.

## Development and upstream updates

Run `npm ci --ignore-scripts`, `npm run build`, and `npm run check`. This checkout includes upstream v1.3.1 and OnQ-specific changes. Do not install the upstream npm package over this adaptation. Review future upstream changes separately, rerun tests, and verify Queen’s after updating the Windows installation.

The live Queen’s API responses, Windows upgrade, and ChatGPT-host UI rendering must be checked on the running Windows machine after each update.
