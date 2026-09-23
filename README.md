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
herdr plugin install ralphilius/herdr-discord
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

### Which channels spawn agents

A channel is watched when **either**:

- its **topic contains a `herdr:` marker** — configure the channel in Discord
  itself, no server file edits needed:

  ```
  herdr: cwd=~/code/my-api kind=claude
  herdr: {"kind": "codex", "cwd": "/srv/infra", "machine": "gpu-box"}
  herdr:                     # marker alone = watch with global defaults
  ```

  Keys: `cwd`, `kind`, `label` (workspace name), `machine`, `workspace`
  (existing workspace id or label — binds instead of creating). Forum channels
  work too — their guidelines field is the topic.

- or it is **bound with `!setup`** — post `!setup` in the channel and pick a
  workspace from the dropdown. The binding is stored in plugin state and also
  watches the channel; no topic or file needed.

- or it has an entry in **`channels.json`** in the plugin config dir (overrides
  the topic):

```json
{
  "1234567890123456789": { "label": "my-api", "cwd": "~/code/my-api", "kind": "claude" }
}
```

Each watched channel maps to one Herdr workspace; threads become tabs inside
it. With `workspace=` or `!setup` the channel adopts an existing workspace
(created via Herdr's New button or any other way) — channel and workspace
names don't need to match. Without a binding, the bridge creates a workspace
labeled after the channel on the first thread.

### Channel commands

Posted in the channel itself (not a thread):

| Command           | Effect                                                  |
| ----------------- | ------------------------------------------------------- |
| `!setup [machine]` | Pick an existing workspace from a dropdown and bind it |
| `!unbind`         | Clear the workspace binding                             |
| `!status`         | Show the channel's binding and mapped-thread count      |
| `!help`           | Show channel commands                                   |

### Routing channels to other machines

`machine` names a saved Herdr machine profile (`herdr machine add <ssh-target>`
on the host running the bot). The bridge then issues all commands for that
channel through `herdr --machine <label>`, so `#gpu-jobs` can spawn agents on a
remote box while `#local` uses the Herdr server the bot runs on. Workspace/tab/
agent IDs are server-local — a channel's workspace lives entirely on its
machine, and status polling queries each machine separately.

Per-thread overrides: put `kind:codex`, `cwd:/path`, and/or `machine:gpu-box`
on their own lines in the thread's starter message.

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

## Running on a server (always on)

Three pieces keep the bridge alive on a headless box:

1. **Herdr server under systemd.** `herdr server` is the headless mode; a
   user unit keeps it running across reboots:

   ```sh
   # on the server
   curl -fsSL https://herdr.dev/install.sh | sh
   mkdir -p ~/.config/systemd/user
   cp deploy/herdr-server.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now herdr-server
   loginctl enable-linger "$USER"   # start at boot, no login needed
   ```

2. **Autostart the bot tab.** With `DISCORD_AUTOSTART=1` in the plugin `.env`,
   the startup hook reopens the bot pane every time the server starts —
   including after reboots. It creates a `discord` workspace first if the
   session has none.

3. **Crash resilience.** The pane entrypoint is `src/run.js`, a supervisor
   that restarts `bot.js` with backoff (5s → 5m). A crash or a bad token
   retries forever instead of silently dying; fixing `.env` self-heals.

On the server, install the plugin and configure it as usual:

```sh
herdr plugin install ralphilius/herdr-discord    # or: git clone … && herdr plugin link .
CONFIG_DIR="$(herdr plugin config-dir herdr.discord)"
cp .env.example "$CONFIG_DIR/.env"            # set DISCORD_BOT_TOKEN, DISCORD_AUTOSTART=1
```

Then drive it from your laptop without SSH: `herdr machine add <ssh-target>`
saves the server as a remote machine, so its workspaces/agents appear in your
local Herdr UI and `herdr --machine <label> …` routes CLI commands there.

**Security:** on a shared Discord server, anyone who can post in a watched
channel can steer your agents — use a private channel and set
`DISCORD_ALLOWED_USERS`.

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
