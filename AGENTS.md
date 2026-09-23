# Rules

## Versioning & releases

Every user-visible change (feature, fix, docs affecting install behavior) must end with a version bump before pushing. The plugin version is what `herdr plugin install` shows in its preview — it's the only signal users have that an install pulled new code.

- Bump with `npm version patch|minor|major` — never edit version strings by hand.
  - `patch`: fixes and small changes
  - `minor`: new features
  - `major`: breaking config/state compatibility
- The `version` lifecycle script (`scripts/sync-version.js`) syncs `herdr-plugin.toml` and stages it, so both files always match `package.json`. Don't bypass it.
- After bumping: `git push && git push --tags`. The release isn't done until the tag is pushed — installs pull from GitHub `main`.

## Commits

- No `Co-Authored-By` or "Generated with" trailers — history was rewritten once to remove them; don't reintroduce them.
- One logical change per commit; imperative subject line.

## Code conventions

- ESM Node (`"type": "module"`), no build step, `discord.js` v14, Node >= 18.
- All Herdr calls go through `src/herdr.js` (`HERDR_BIN_PATH`, never a hardcoded socket path). Global flags like `--machine` are prepended by `withMachine` — pass `machine` via the options arg, don't add flags manually.
- Verify with `node --check` on changed files; no test framework exists.
- Never commit `DISCORD_BOT_TOKEN` or `.env` (gitignored).
