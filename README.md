# herdr-discord

A [Herdr](https://herdr.dev) plugin that turns Discord into a UI layer for coding agents.

- **Each Discord channel is a Herdr workspace.**
- **Each new thread is a tab in that workspace running a new agent.**
- Replies in the thread become agent prompts; agent status (`blocked`, `done`)
  and output are posted back into the thread.

The bot itself runs inside Herdr as a plugin pane — a real terminal tab, so its
logs are visible in Herdr and its lifetime is managed by the Herdr server.

## Requirements

- Herdr `>= 0.9.0`
- Node.js `>= 18`
- A Discord application with a bot token

## Discord setup

1. Create an app at <https://discord.com/developers/applications> and copy the
   bot token.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content**.
3. Invite the bot with the `bot` scope and permissions:
   *View Channels*, *Send Messages*, *Send Messages in Threads*,
   *Read Message History*.

## Install

From GitHub (once pushed):

```sh
herdr plugin install <owner>/herdr-discord
```

Or link a local checkout while developing:

```sh
git clone <this repo>
cd herdr-discord
npm ci
herdr plugin link .
```

## Configure

```sh
CONFIG_DIR="$(herdr plugin config-dir herdr.discord)"
cp .env.example "$CONFIG_DIR/.env"
# optional: per-channel routing
cp channels.example.json "$CONFIG_DIR/channels.json"
```

Edit `$CONFIG_DIR/.env` — at minimum `DISCORD_BOT_TOKEN`. See
[.env.example](.env.example) for every option.

`channels.json` maps Discord channel IDs to Herdr settings. Each listed channel
gets its own lazily-created workspace; threads become tabs inside it:

```json
{
  "1234567890123456789": { "label": "my-api", "cwd": "~/code/my-api", "kind": "claude" }
}
```

When `channels.json` is absent or empty, **every** channel accepts agent threads
using the global defaults. When it has entries, only listed channels are
watched.

Per-thread overrides: put `kind:codex` and/or `cwd:/path` on their own lines in
the thread's starter message.

## Run

```sh
herdr plugin action invoke herdr.discord.open-bot   # opens the bot tab
herdr plugin action invoke herdr.discord.status     # prints bridge state
```

Or open the pane directly:

```sh
herdr plugin pane open --plugin herdr.discord --entrypoint bot --placement tab
```

Set `DISCORD_AUTOSTART=1` in `.env` to reopen the bot tab automatically whenever
the Herdr server starts.

Optional keybinding for your Herdr config:

```toml
[[keys.command]]
key = "prefix+d"
type = "plugin_action"
command = "herdr.discord.open-bot"
description = "open Discord bot"
```

## Using the bridge

1. Create a thread (or forum post) in a watched channel. The bot starts a
   `<kind>` agent in a new Herdr tab and confirms in the thread.
2. Any message in the thread is sent to the agent as a prompt, prefixed with
   your display name. Attachments are passed through as URLs.
3. When the agent blocks on a question or finishes a turn, the bot posts the
   status plus the relevant terminal output.

### Answering blocked agents

When an agent goes `blocked` (permission prompt, numbered menu, y/n question),
the bot posts the terminal snapshot followed by a message with buttons:

- **Numbered menus** — the bot parses `❯ 1. Yes / 2. No`-style options from the
  snapshot and renders a button per option. Clicking sends arrow keys + Enter
  (or the number key when no cursor row is visible).
- **y/n prompts** — Yes / No buttons send the `y`/`n` keys.
- **Anything else** — Approve (Enter) and Cancel (Esc) fallback buttons.
- **Type answer…** — opens a modal; the text is typed into the agent's pane
  and submitted with Enter.

After an answer the buttons are replaced by a note of who answered. If the
agent was already unblocked in Herdr, clicking shows that instead of sending
keys. Buttons honor `DISCORD_ALLOWED_USERS`.

### Thread commands

| Command      | Effect                                        |
| ------------ | --------------------------------------------- |
| `!status`    | Agent status + workspace/tab/pane ids         |
| `!read [n]`  | Post the last n lines of agent output         |
| `!approve`   | Send Enter to a blocked agent (buttons usually cover this) |
| `!close`     | Close the agent's Herdr tab and unmap thread  |
| `!help`      | Show commands                                 |

## How it works

- `src/bot.js` — discord.js gateway client; maps `threadCreate` →
  `workspace create` + `tab create` + `agent start`, `messageCreate` →
  `agent prompt`, polls `agent list` to relay status back, and answers
  blocked agents via button/modal interactions.
- `src/prompts.js` — parses detection snapshots into clickable options
  (numbered menus, y/n prompts) and maps them to Herdr keys.
- `src/herdr.js` — thin async wrapper over `HERDR_BIN_PATH` (the Herdr CLI is
  the plugin API; JSON in, JSON out).
- `src/state.js` — thread/channel → agent/workspace mapping, persisted under
  `HERDR_PLUGIN_STATE_DIR`.
- `src/config.js` — `.env` + `channels.json` from `HERDR_PLUGIN_CONFIG_DIR`
  (with plugin-root fallback for development).

No separate daemon, database, or socket client is needed: Herdr owns the
process, Discord owns the UI.
