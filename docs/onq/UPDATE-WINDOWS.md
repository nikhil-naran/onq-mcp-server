# Update the running Windows server

Use these steps in PowerShell as the same Windows user that runs OnQ. They keep `%LOCALAPPDATA%\OnQMCP` (Queen's browser session, configuration, tunnel key, and caches) in place. Do not share that folder or commit it.

## 1. Stop the running tunnel

If the tunnel is open in a PowerShell window, press Ctrl+C there. If you use the startup task:

```powershell
Stop-ScheduledTask -TaskName 'OnQ ChatGPT'
```

Wait for the tunnel process to exit before continuing. This disconnects ChatGPT temporarily.

## 2. Update this checkout

```powershell
cd C:\OnQ\onq-server
git status --short
git branch --show-current
git pull --ff-only origin codex/onq-windows
.\scripts\windows\Setup-OnQ.ps1
```

`git status --short` should print nothing and the branch should be `codex/onq-windows`. If either differs, stop and ask the Windows agent to inspect the checkout before pulling. `Setup-OnQ.ps1` installs the locked dependencies, Chromium, and the new build; it preserves existing OnQ settings. It may take several minutes.

## 3. Start and verify

For a foreground tunnel, run `.\scripts\windows\Start-Tunnel.ps1`. For the startup task, run:

```powershell
Start-ScheduledTask -TaskName 'OnQ ChatGPT'
```

The existing ChatGPT connection should remain associated with the same tunnel. Refresh the connection's tool list in ChatGPT if the new tools do not appear. Ask for your course list, a seven-day agenda, and one known assignment. Compare them with the OnQ website. Ask for quiz and calendar entries separately and check that unavailable sources are reported as incomplete rather than empty.

If Queen's asks for sign-in again, run `.\scripts\windows\Login-OnQ.ps1` in the same Windows session, finish SSO/MFA, then restart the tunnel. A Mac-side build and automated tests cannot establish whether Queen's grants each API endpoint to your account.

## If the update fails

Keep the tunnel stopped and record the exact error. `git reflog -2` shows the previous commit. To return to it, ask the Windows agent to verify that the checkout has no personal edits, then switch to that commit, rerun `Setup-OnQ.ps1`, and restart the tunnel. Do not clear `%LOCALAPPDATA%\OnQMCP` during rollback.
