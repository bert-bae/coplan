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
UI are on the server. The server cannot see a client's repository, so the
client sends what it needs: the repository's `.coplan/config.json` (with each
MCP call) and its git `HEAD` (when a task starts). Until a session's first MCP
call the server uses default config. Your own global defaults
(`coplan.json`, `instructions/`) are read from the *server's* home, not the
client's. Plan-file export (`.coplan/plans/`) is for headless sessions only and
is not done for remote ones.

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
| `COPLAN_TOKEN` | random each start | The key clients send. Set it, or clients cannot know it. A comma-separated list gives each machine its own: revoke or rotate one by editing the list and restarting. |
| `COPLAN_PORT` | random | Port to listen on. |
| `COPLAN_BIND` | `127.0.0.1` | Address to listen on. `0.0.0.0` only on a network you trust, or behind a proxy. |
| `COPLAN_PUBLIC_URL` | none | The address your browser and clients use, if it is not `http://127.0.0.1:<port>` (a proxy, a Tailscale name). Comma-separated if there are several (a tunnel on another local port): the first is the one links use. Each passes the Host and Origin checks. |
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

The key sits in plain text in that file, and in the relay's environment: use
this on machines you alone use. The relay hands it to `curl` through a
private temporary file, not the command line.

If the server cannot be reached, a new Claude Code session says so once as it
starts, and MCP tools return an error naming the server. Keep the tunnel up
(`autossh`) and check `coplan status`. If a client's plugin build differs from
the server's, the MCP tools append a notice: update both together.

## Operating it

- **TLS.** Over an SSH tunnel to loopback, nothing crosses the network in
  clear. Bound to `0.0.0.0` with a plain `http` public URL, the daemon logs a
  warning: put TLS in front (a reverse proxy, Tailscale HTTPS) or keep it on
  loopback.
- **Back up** the state folder (`CC_HARNESS_HOME`): every plan is in it.
  Docker: `docker run --rm -v coplan-data:/data -v "$PWD":/b busybox tar czf /b/coplan.tgz -C /data .`
  Without Docker: `tar czf coplan.tgz -C /var/lib/coplan .`. Restore by
  unpacking into an empty folder before starting.
- **Sessions that crash** never send their end hook, so they stay listed as
  active until you delete them in the UI.
