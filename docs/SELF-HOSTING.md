# Self-hosting Coplan

Run one Coplan daemon on a server (a home lab box) and point the agents on
your desktop and laptop at it. Every plan, task list and the board live in one
place, behind one UI, whichever machine the agent runs on.

```
desktop / laptop                       server
 Claude Code ── hooks, MCP, CLI ─────▶ coplan daemon  ◀── browser (the UI)
   COPLAN_REMOTE + COPLAN_TOKEN         127.0.0.1:4321, via SSH tunnel
```

**What is shared, and what is not.** Plans, tasks, comments, the board and the
UI are on the server. A repository's `.coplan/config.json`, git state and
plan-file export are read from the *server's* disk, so for a remote session
they are defaults (no per-repo checks, no recorded start commit) until a
repository of the same path exists there.

## 1. Run the daemon (pick one)

Both need a secret key every client sends. Make one: `openssl rand -hex 24`.

### With Docker

```sh
git clone https://github.com/bert-bae/coplan && cd coplan
COPLAN_TOKEN=<key> docker compose up -d --build
```

State is in the `coplan-data` volume. It listens on `127.0.0.1:4321` only.

### Without Docker

Needs Node 24 or later and pnpm.

```sh
git clone https://github.com/bert-bae/coplan /opt/coplan && cd /opt/coplan
pnpm install            # builds dist/
echo 'COPLAN_TOKEN=<key>' | sudo tee /etc/coplan.env && sudo chmod 600 /etc/coplan.env
sudo cp deploy/coplan.service /etc/systemd/system/    # edit User and paths
sudo systemctl enable --now coplan
```

Or, to try it by hand:
`COPLAN_TOKEN=<key> COPLAN_PORT=4321 COPLAN_SELF_HOSTED=1 node dist/daemon/main.js`.

### Server settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `COPLAN_TOKEN` | random each start | The key clients send. Set it, or clients cannot know it. |
| `COPLAN_PORT` | random | Port to listen on. |
| `COPLAN_BIND` | `127.0.0.1` | Address to listen on. `0.0.0.0` only on a network you trust, or behind a proxy. |
| `COPLAN_PUBLIC_URL` | none | The address your browser and clients use, if it is not `http://127.0.0.1:<port>` (a proxy, a Tailscale name). Its host passes the Host and Origin checks, and links use it. |
| `COPLAN_SELF_HOSTED` | off | `1`: stay up when idle, and restart by restarting the service. |
| `CC_HARNESS_HOME` | `~/.claude/cc-harness` | Where state lives. |

## 2. Reach it from each machine

Keep the daemon on loopback and tunnel to it:

```
# ~/.ssh/config on the desktop and the laptop
Host homelab
  LocalForward 4321 127.0.0.1:4321
  ServerAliveInterval 30
```

Keep it open with `autossh -M 0 -f -N homelab`. (A reverse proxy with TLS, or
Tailscale, also works: set `COPLAN_PUBLIC_URL` and use that URL below.)

## 3. Point the agent at it

Install the Coplan plugin on each client as usual (`./setup.sh`), then in
`~/.claude/settings.json`:

```json
{ "env": { "COPLAN_REMOTE": "http://127.0.0.1:4321", "COPLAN_TOKEN": "<key>" } }
```

Hooks, the MCP server and the `coplan` CLI then call the server, and never
start a local daemon. `coplan status` and `coplan url` (a signed-in link) work
from any client. `coplan stop` and `coplan restart` refuse: do those on the
server.

The hook relay passes the key to `curl` on its command line, readable by other
local users of the same client. Use this on machines you alone use.
