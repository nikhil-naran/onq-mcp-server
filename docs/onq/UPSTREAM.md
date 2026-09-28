# Upstream and provenance

Base: JhostinAleck/brightspace-mcp at 6d3b6556eca4752ce34ff3ed582a900a71032bd6 (MIT).
OnQ behavior adapted from nikhil-naran/onq-mcp-server at db30ad777ecca703ae9fe1b544a07dbc95fe6d4c.

The original MIT license is retained. The package is marked private to prevent accidental npm publication. The local fork has not been pushed to GitHub. Do not run the upstream upgrade command over this adaptation.

Changes: persistent human browser authentication; explicit cookiefile credential scheme; single-flight authentication; rubric/completion tools; mixed-source agenda with warnings and Toronto times; optional MCP Apps agenda; capped PDF images; authenticated bounded downloads with same-origin redirect enforcement; Windows user-session setup, DPAPI tunnel key storage and scheduled startup.

The prepended OnQ README describes this branch. Upstream release claims and CLI documentation may describe different behavior. Review updates before merging and retain live Queen’s tests as an acceptance gate.
