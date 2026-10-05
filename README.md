# Claude Code plugins

Two UI mods for Claude Code (terminal, desktop app, VS Code).

| Plugin | macOS | Linux | Windows |
| --- | --- | --- | --- |
| progress-bar | yes | yes | yes (no OS-specific code) |
| play-button | yes | likely (needs `sh`, `perl`, `zsh`) | **no**: it launches services through `/bin/sh` and `/bin/zsh` and stops them with POSIX process groups |

- **progress-bar**: a bar with a % estimate and elapsed time, a ▲/▼ arrow against the first estimate, and a clock that pauses while Claude waits for your answer or a permission.
- **play-button**: a ▶/‖ button that detects how to run the current repo and starts or stops it.

## Install

```bash
claude plugin marketplace add kshitiz-swim/claude-plugins
claude plugin install progress-bar@kshitiz-plugins
claude plugin install play-button@kshitiz-plugins
```

Restart Claude Code (or reload the VS Code Claude panel) afterwards.

## Cloud or per-project sessions

Add this to a project's `.claude/settings.json` so a fresh machine installs them on startup:

```json
{
  "extraKnownMarketplaces": {
    "kshitiz-plugins": { "source": { "source": "github", "repo": "kshitiz-swim/claude-plugins" } }
  },
  "enabledPlugins": {
    "progress-bar@kshitiz-plugins": true,
    "play-button@kshitiz-plugins": true
  }
}
```
