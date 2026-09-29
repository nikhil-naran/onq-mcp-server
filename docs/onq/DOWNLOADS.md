# Original-file links hosted on Windows

This optional mode returns short-lived HTTPS links to original onQ files instead of asking ChatGPT to reconstruct base64. Files stay in memory on the existing always-on Windows host. Cloudflare Tunnel relays HTTPS downloads; it does not provide object storage for this feature. Nothing runs on the user's phone or Mac.

The current default remains embedded delivery. Do not claim upload-equivalent behavior until ChatGPT actually downloads and reads a linked file in the target phone session. A browser-visible download alone is insufficient.

## Before configuring

- Use the same Windows user, Queen's login, private MCP tunnel and disabled LMS writes from [SETUP.md](SETUP.md).
- This change is based on `main`. Older setup docs point to `codex/onq-windows`, and GitHub's default branch is `master`. The Windows agent must verify `git status`, the installed branch and the reviewed download-feature commit. Do not blindly pull another branch over an existing installation. Use a clean checkout/worktree of the reviewed feature branch (or main after merge), then run `Setup-OnQ.ps1`. If its path changes, rerun `Configure-Tunnel.ps1` and recreate the existing startup task so both use the new checkout. Preserve `%LOCALAPPDATA%\OnQMCP`.
- Install an official `cloudflared.exe` and put it on PATH. A stable hostname on a Cloudflare-managed domain is required for these locally managed tunnel scripts. Use an existing suitable domain; do not change unrelated DNS records or nameservers just to run this setup without the owner's direction.
- The download hostname must be reachable by ChatGPT's cloud file-fetch tools. Network restrictions or lack of a file-fetch capability can still block this integration. No custom `file_id` or MCP resource shape guarantees native attachment ingestion.

Official references: [create a tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/), [ingress configuration](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/), [OpenAI private MCP tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## 1. Create a dedicated outbound download tunnel

Run as the normal Windows user in PowerShell. This is a different tunnel from OpenAI's MCP tunnel. Cloudflare login opens its own browser flow; never paste credentials into chat.

```powershell
cloudflared tunnel login
cloudflared tunnel create onq-downloads
```

Record the returned UUID and credentials-file path. Choose a dedicated hostname you control (the following values are placeholders):

```powershell
.\scripts\windows\Configure-Downloads.ps1 `
  -Hostname downloads.example.com `
  -TunnelId 00000000-0000-0000-0000-000000000000 `
  -CredentialsFile "$env:USERPROFILE\.cloudflared\00000000-0000-0000-0000-000000000000.json"

cloudflared tunnel route dns 00000000-0000-0000-0000-000000000000 downloads.example.com
.\scripts\windows\Start-DownloadTunnel.ps1
```

The configuration script protects its directory with Windows ACLs, checks the credential UUID, and generates ingress that exposes only `/files/<64-hex-token>/<filename>`, with a 404 catch-all. The origin is fixed to `127.0.0.1:8766`; no MCP, browser-debug or filesystem endpoint is exposed. It does not create DNS records itself. Configuring without `-EnableDownloads` leaves onQ delivery unchanged.

In Cloudflare, bypass caching on the dedicated hostname and avoid URL/token logging, HTML challenges or an interactive Access login on these downloads. The origin sends `private, no-store` and grants access only through random expiring tokens. Do not enable debug/request logging on the relay or publish token URLs in issues. The relay terminates HTTPS and can process the streamed data; this is not end-to-end encryption through an untrusted relay.

## 2. Test synthetic data before enabling coursework delivery

Keep the download tunnel running. In another PowerShell window:

```powershell
.\scripts\windows\Start-DownloadProbe.ps1
```

This serves only a generated two-page PDF, prints a 15-minute link and its byte count/SHA-256, and never authenticates to Queen's. In ChatGPT on the phone, ask it to download the file, verify the checksum, and describe the final-page text and diagram. Expected last-page content: `ORCHID-471`, a blue rectangle on the left and red rectangle on the right connected by a line. Also test the desktop host. Do not send private coursework links to web search as a workaround.

Record separately: link rendered; user download works; agent download works; checksum correct; diagram read; native attachment presentation. Require agent download and reading, not just the first two. If the agent cannot fetch the URL, leave embedded mode enabled and report the exact host/network limitation. The code cannot fix host attachment ingestion through prompting alone.

Stop the probe with Ctrl+C before starting onQ download mode: they use the same port. Stopping it revokes the probe URL.

## 3. Enable original-file links

Stop the running onQ task/tunnel, then repeat configuration with `-EnableDownloads`:

```powershell
Stop-ScheduledTask -TaskName 'OnQ ChatGPT'
.\scripts\windows\Configure-Downloads.ps1 `
  -Hostname downloads.example.com `
  -TunnelId 00000000-0000-0000-0000-000000000000 `
  -CredentialsFile "$env:LOCALAPPDATA\OnQMCP\downloads\credentials.json" `
  -EnableDownloads
Start-ScheduledTask -TaskName 'OnQ ChatGPT'
```

For a foreground installation, stop/start `Start-Tunnel.ps1` instead. The script validates the existing YAML using the built config schema, saves a backup next to it, and updates only `file_delivery`. It preserves Queen's auth configuration and LMS write settings. The download listener starts inside the onQ server process, so it shares the same memory/lifecycle; it is not a second onQ server.

Effective defaults:

```yaml
file_delivery:
  mode: download
  public_base_url: https://downloads.example.com
  port: 8766
  ttl_seconds: 900
  max_cache_bytes: 134217728
  max_entries: 16
  max_concurrent_retrievals: 2
  max_concurrent_responses: 16
```

No course bytes are written to disk or uploaded to object storage. The existing 25 MiB source-download limit remains; the 6 MiB inline response limit applies only to embedded mode. Worst-case 25 MiB capacity is reserved before each source fetch. Capacity exhaustion fails clearly rather than evicting still-valid links. Failed source reads release reservations.

Expiry is checked on every GET/HEAD. Expired idle buffers are swept each minute; in-flight downloads can complete and remain counted until released. Restart drops all links. Repeating `retrieve_onq_file` reauthorizes/retrieves the source and creates a fresh token. A link grants access to anyone possessing it until expiry even if onQ permissions change; stopping the service immediately revokes all links. Disconnecting the MCP plugin alone does not revoke issued links.

## 4. Startup and operation

After the foreground tests pass:

```powershell
.\scripts\windows\Install-DownloadTunnelStartupTask.ps1
Start-ScheduledTask -TaskName 'OnQ Downloads'
```

Stop the foreground download tunnel before starting the task. Both `OnQ ChatGPT` and `OnQ Downloads` run under the same logged-in Windows user. The existing onQ task owns the file listener; the new task owns only `cloudflared`. Either may start first; downloads work once both are ready. Keep Windows awake/online. Existing task settings retry failures ten times at one-minute intervals. Check task status after reboot/sign-in; these are not headless SYSTEM services.

The tool knows the local listener is running, but cannot prove the reverse tunnel is externally reachable. A returned link therefore means locally prepared, not host-downloaded. A 502 usually calls for checking the listener/port; host/network blocks require a separate reachability check. Logs must not include full token URLs.

## Acceptance and rollback

Test PDF final-page diagrams and exact bytes, a 7+ MiB file, Unicode filenames, HEAD/range requests, repeated GETs, expiry/renewal, Windows restart, and an expired Queen's session. All five original-file sources should work: topics, course paths, assignments, announcements, submissions. Refresh the ChatGPT connection's tool metadata after upgrading.

For rollback, stop both tasks, set `file_delivery.mode: embedded` in `%LOCALAPPDATA%\OnQMCP\config.yaml`, restart only `OnQ ChatGPT`, and remove the `OnQ Downloads` task if no longer wanted. Stopping the onQ process clears the memory cache. Do not delete the Queen's profile or tunnel credentials. Remove the dedicated Cloudflare DNS route/tunnel separately if retiring the feature.

## Validation boundary

The repository tests cover local original-byte HTTP delivery and MCP response construction. They do not establish live Windows PowerShell execution, Cloudflare account/DNS setup, private onQ access, or ChatGPT iPhone file ingestion. Those remain explicit deployment acceptance steps; no public download endpoint is enabled by merely installing this code.
