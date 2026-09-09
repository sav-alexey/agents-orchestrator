# Running it

The setup in use: **Qdrant in Docker, backend on the host, UI in Electron.**

Where the backend runs is where the agent's tools run — its `Bash`, `git` and
`python` are the ones on that machine. On the host an agent gets your real
toolchain: project `.venv`s, `uv`, `psql`, `ssh`, services on `localhost`. None of
that exists inside the backend image, so the containerised variant (bottom of this
file) suits projects whose work is self-contained and not much else.

## Once

```sh
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
npm install
cp .env.example .env       # compose reads it; only the containerised backend needs a token
```

Authentication needs nothing here: the host `claude` uses the desktop login from
the macOS Keychain.

## Every time

```sh
npm run db         # docker compose up -d qdrant
npm run backend    # uvicorn on :8756 — stays in the foreground, keep the terminal
npm start          # the Electron window, in another terminal
```

The window starts nothing of its own; if the backend is not up it says so and
quits. Point it elsewhere with `ORCHESTRATOR_BACKEND=http://box:8756 npm start`.

Qdrant keeps running between sessions — that is the point of it being a container.
`docker compose down` when you want it gone.

| Piece     | Where  | Port | What it is                                                  |
| --------- | ------ | ---- | ----------------------------------------------------------- |
| `qdrant`  | Docker | 6333 | Vector memory. Dashboard at http://localhost:6333/dashboard |
| `backend` | host   | 8756 | FastAPI + the `claude` CLI it drives                        |
| Electron  | host   | —    | The UI, from `renderer/`                                    |

## After a change

| Changed          | Do this                                        |
| ---------------- | ---------------------------------------------- |
| `renderer/*`          | reload the window (Cmd+R)                 |
| `main.js`/`preload.js`| restart `npm start`                       |
| `config.yaml`         | restart the backend — groups load at startup |
| `backend/app/*`       | restart the backend                       |

`npm run backend -- --reload` restarts it for you on every save. It drops live
sessions when it does, but they resume from their stored session id on the next
message.

## Adding a project

The **+** at the bottom of the project rail opens a folder picker, appends the
group to `config.yaml` and registers it immediately — no restart, and the comments
in the file survive. It then asks whether the project gets full access, i.e.
whether its agents run without permission prompts.

A browser tab has no way to browse the filesystem, so there the path is typed
instead. Either way the backend checks the folder *from where it runs*: a
containerised backend refuses a path that is not mounted into it.

## All of it in Docker

```sh
docker compose up -d --build    # qdrant + backend + the UI on :8080
npm start                       # optional: the same UI in the Electron window
```

Four things change, and they are why this is not the default:

- **A token is required.** The Keychain login is unreadable from a container, so
  `.env` needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or
  `ANTHROPIC_API_KEY`. Without one every chat fails with `Not logged in`.
- **The image is the toolchain.** `git`, `ripgrep`, `node`/`npx`, `python3` and the
  Docker client are in it; `uv`/`uvx`, `psql`, `ssh`, compilers are not. A project
  `.venv` is mounted but was built for macOS and will not execute there.
- **`localhost` is the container**, not your Mac — host services are reachable as
  `host.docker.internal`.
- **It runs as root**, and the CLI refuses to skip permission prompts as root, so
  `IS_SANDBOX=1` in `docker-compose.yml` is what keeps `full_access: true` groups
  working.

## Sending and stopping

Only one prompt is with the CLI at a time. Type while the agent works and the
message waits in the session, shown as queued, and goes over when the current
turn ends — the same arrangement Claude Code itself uses.

**Stop** therefore means stop: it aborts the running turn *and* drops everything
queued behind it, handing those messages back to the composer rather than running
them. The button reads "Stopping…" until the turn actually ends, which inside a
long subagent call can take a while — the CLI only unwinds when it returns.

## Watching a long run

A turn that spends hours inside one Agent call streams nothing of its own — the
CLI reports the main conversation only. The backend therefore tails the session's
subagent transcripts under `~/.claude/projects/<project>/<session>/subagents/` and
emits what it finds as `agent_activity` events; the chat shows them in a live
panel with a running count and the last 40 lines.

Everything a run emits is also kept in memory and replayed to whoever subscribes
next, so reloading the window mid-run redraws the trace instead of showing an
empty chat. Two knobs, both environment variables on the backend:

| Variable                 | Default | What it does                            |
| ------------------------ | ------- | --------------------------------------- |
| `ACTIVITY_POLL_SECONDS`  | `3`     | how often the transcripts are re-read   |
| `LIVE_EVENT_BUFFER`      | `1500`  | how many events a reconnect can replay  |

None of this reaches the database: only a finished turn is stored, so a run that
dies mid-flight leaves the files it wrote on disk but no transcript in the chat.

## When it misbehaves

**The window opens and everything 404s, or a send fails with
`Unexpected token 'd', "data: {"ty"…`.** The UI and the backend are out of step —
the page is calling a route the running backend does not have. Restart the backend
and reload the window.

**`Cannot read properties of undefined (reading 'whenReady')` on `npm start`.**
`ELECTRON_RUN_AS_NODE=1` is in the environment — VS Code's integrated terminal sets
it, and it makes Electron start as plain Node. Launch from a normal terminal, or
`env -u ELECTRON_RUN_AS_NODE npm start`.

**Port 8756 already in use.** Usually the backend container from the all-Docker
setup: `docker compose stop backend`. `lsof -nP -iTCP:8756 -sTCP:LISTEN` names
whatever it is.

**A group's slash commands are missing.** The list is read from a real CLI session,
and the UI caches an empty result if that probe fails, for as long as the page
lives. Fix whatever broke the session, then reload the window.

**MCP tools missing in the first message of a new chat.** Servers started through
`npx`/`uvx` are still connecting when the CLI announces its tool list. They are all
there from the second turn on.

**`permissions.allow` from a project's `.claude/settings.json` is ignored.** The CLI
says so in the backend log: the workspace has not been trusted. Run `claude` in that
folder once and accept the dialog.
