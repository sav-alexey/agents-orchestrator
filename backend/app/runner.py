from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections import deque
from pathlib import Path
from typing import Callable

import claude_agent_sdk as sdk

from app import db, memory

logger = logging.getLogger(__name__)

# Every `claude` subprocess this module spawns inherits this process's env,
# PATH included. Project-configured MCP servers that shell out through `uvx`
# or `npx` (jira, gitlab, ...) then fail to connect — silently, as far as the
# agent is concerned, it just doesn't have the tool — whenever the backend was
# started from a shell that never sourced Homebrew's or cargo's paths (a bare
# `npm run backend`, a non-login shell). Widen PATH once here so it doesn't
# depend on how the backend happens to be launched.
for _extra_bin in ("/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".cargo" / "bin")):
    if _extra_bin not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = os.pathsep.join(filter(None, [os.environ.get("PATH", ""), _extra_bin]))

PERMISSION_TIMEOUT_SECONDS = int(os.environ.get("PERMISSION_TIMEOUT_SECONDS", 600))
QUESTION_TIMEOUT_SECONDS = int(os.environ.get("QUESTION_TIMEOUT_SECONDS", 1800))

# How long an idle chat may hold its `claude` subprocess open before we shut it
# down. Reconnecting is transparent: the session resumes from the stored
# session_id, so the only cost is a second of startup on the next message.
SESSION_IDLE_SECONDS = int(os.environ.get("SESSION_IDLE_SECONDS", 1800))

# Ceiling on a single JSON message from the CLI (see _ensure_client). Costs
# nothing until a message actually arrives that big.
MAX_BUFFER_SIZE = int(os.environ.get("MAX_BUFFER_SIZE", 64 * 1024 * 1024))

# The built-in tool Claude calls when it wants to ask the user a multiple-choice
# question. It reaches us through the same can_use_tool hook as any other tool,
# but instead of allow/deny the UI has to collect *answers* and hand them back as
# the tool's input — see _ask_questions().
QUESTION_TOOL = "AskUserQuestion"

# Sent to a session's subscribers when that session object is retired (a model or
# effort change, an idle reap): whoever is streaming it must re-resolve the chat's
# session and resubscribe, or it would hold a queue nothing emits to ever again.
SESSION_GONE = "session_gone"

# request_id -> Future[str] resolved with "allow" or "deny" by the /permissions endpoint.
pending_permissions: dict[str, asyncio.Future] = {}

# request_id -> Future[dict | None] resolved by the /questions endpoint with
# {"answers": {question_text: label}, "response": str | None}, or None when skipped.
pending_questions: dict[str, asyncio.Future] = {}


def _serialize(message: object) -> dict:
    if isinstance(message, sdk.StreamEvent):
        return {"type": "stream_event", "event": message.event, "session_id": message.session_id}
    if isinstance(message, sdk.ResultMessage):
        return {
            "type": "result",
            "subtype": message.subtype,
            "is_error": message.is_error,
            "result": message.result,
            "session_id": message.session_id,
            "total_cost_usd": message.total_cost_usd,
            "duration_ms": message.duration_ms,
            "usage": message.usage,
        }
    if isinstance(message, sdk.SystemMessage):
        return {"type": "system", "subtype": message.subtype, **(message.data or {})}
    return {"type": type(message).__name__}


def _normalize_answers(answers: object, questions: list) -> dict[str, str]:
    """Coerce the UI's answers into what the CLI's AskUserQuestion schema expects:
    a {question text -> answer} map, with multi-select picks comma-joined."""
    if not isinstance(answers, dict):
        return {}

    known = {q.get("question") for q in questions if isinstance(q, dict)}
    normalized: dict[str, str] = {}
    for question, value in answers.items():
        if question not in known:
            continue  # the CLI rejects answers to questions it never asked
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value if str(v).strip())
        value = str(value).strip()
        if value:
            normalized[question] = value
    return normalized


async def _ask_questions(tool_input: dict, emit: Callable[[dict], None]):
    """Hand an AskUserQuestion call to the UI and wait for the user to click answers.

    Answering means allowing the tool with its input rewritten to carry the picks
    (`answers`, plus `response` for free-text) — that's how the CLI feeds them back
    to the model. Skipping (or timing out) denies instead, which the model reads as
    "the user did not answer" and continues on its own judgment.
    """
    request_id = str(uuid.uuid4())
    questions = tool_input.get("questions") or []
    future: asyncio.Future = asyncio.get_running_loop().create_future()
    pending_questions[request_id] = future

    emit({"type": "question_request", "request_id": request_id, "questions": questions})

    try:
        reply = await asyncio.wait_for(future, timeout=QUESTION_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        reply = None
    finally:
        pending_questions.pop(request_id, None)

    if reply is None:  # skipped by the user, or nobody answered in time
        emit({"type": "question_resolved", "request_id": request_id, "skipped": True})
        return sdk.PermissionResultDeny(behavior="deny", message="The user did not answer the questions.")

    answers = _normalize_answers(reply.get("answers"), questions)
    response = str(reply.get("response") or "").strip()

    updated_input = {**tool_input}
    if answers:
        updated_input["answers"] = answers
    if response:
        updated_input["response"] = response

    emit(
        {
            "type": "question_resolved",
            "request_id": request_id,
            "answers": answers,
            "response": response or None,
            "skipped": False,
        }
    )
    return sdk.PermissionResultAllow(behavior="allow", updated_input=updated_input)


# ---------------------------------------------------------------------------
# Project memory, exposed to the agent as an in-process MCP server
#
# The tools are built per session so they can close over which project and chat
# is calling: the agent never has to pass (or be trusted with) a group name, and
# one chat can't read or write another project's memory.
# ---------------------------------------------------------------------------

MEMORY_SERVER = "project_memory"
MEMORY_TOOLS = [f"mcp__{MEMORY_SERVER}__search_memory", f"mcp__{MEMORY_SERVER}__save_memory"]

MEMORY_PROMPT = """\
This project has a shared long-term memory in Qdrant, spanning every chat ever \
held about it — including chats whose transcript you cannot see. Finished turns \
are indexed there automatically.

- Call `search_memory` before non-trivial work here, and whenever the user refers \
to something decided, tried or explained "earlier", "last time" or "in another chat". \
It is the only way to reach that history.
- Call `save_memory` when something worth carrying into later chats settles: a \
decision and its reason, a constraint discovered the hard way, a convention, a \
fix for a problem that will recur. Write it so it is useful to a session that has \
none of this context — no "as discussed above". Do not save what the code, the \
git history or CLAUDE.md already state.\
"""


def _text_result(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


def _format_hits(hits: list) -> str:
    blocks = []
    for i, hit in enumerate(hits, 1):
        when = (hit.created_at or "")[:10]
        label = hit.chat_title or f"chat {hit.chat_id}"
        blocks.append(f"[{i}] {hit.kind} · {label} · {when} · score {hit.score:.2f}\n{hit.text}")
    return "\n\n---\n\n".join(blocks)


def _memory_tools(session: "ChatSession") -> list:
    @sdk.tool(
        "search_memory",
        "Search this project's long-term memory: past chats about this same project, "
        "and notes saved from them. Use it to recover decisions, constraints and "
        "solutions from conversations that are not in your context. Query in the "
        "language the work was discussed in.",
        {"query": str, "limit": int},
    )
    async def search_memory(args: dict) -> dict:
        query = str(args.get("query") or "").strip()
        if not query:
            return {**_text_result("Provide a non-empty query."), "is_error": True}
        limit = args.get("limit")
        limit = max(1, min(int(limit), 20)) if isinstance(limit, (int, float)) else None

        hits = await memory.store.search(
            group_name=session.group_name, query=query, limit=limit
        )
        session.emit(
            {
                "type": "memory_search",
                "query": query,
                "results": len(hits),
                "chat_id": session.chat_id,
            }
        )
        if not hits:
            status = memory.store.status()
            if not status["enabled"]:
                return _text_result("Project memory is disabled in config.yaml.")
            if status["error"]:
                return _text_result(f"Project memory is unreachable: {status['error']}")
            return _text_result("Nothing in this project's memory matches that query.")
        return _text_result(_format_hits(hits))

    @sdk.tool(
        "save_memory",
        "Save a fact worth carrying into later chats about this project — a decision "
        "and its reason, a constraint, a convention, a recurring fix. Write it "
        "self-contained: a future session will read it with none of this conversation "
        "in view.",
        {"text": str},
    )
    async def save_memory(args: dict) -> dict:
        text = str(args.get("text") or "").strip()
        if len(text) < 15:
            return {
                **_text_result("Nothing saved: give a self-contained fact, not a fragment."),
                "is_error": True,
            }
        stored = await memory.store.remember(
            group_name=session.group_name,
            chat_id=session.chat_id,
            chat_title=session.chat_title,
            text=text,
            kind="note",
        )
        if not stored:
            status = memory.store.status()
            reason = status["error"] or ("disabled" if not status["enabled"] else "unavailable")
            return {**_text_result(f"Could not save to project memory ({reason})."), "is_error": True}
        session.emit({"type": "memory_saved", "text": text, "chat_id": session.chat_id})
        return _text_result(f"Saved to {session.group_name}'s memory.")

    return [search_memory, save_memory]


def _normalize_commands(info: dict | None) -> list[dict]:
    """Turn the CLI handshake's command list into what the composer needs."""
    commands = []
    for entry in (info or {}).get("commands") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        commands.append(
            {
                "name": name,
                "description": str(entry.get("description") or "").strip(),
                "argument_hint": str(entry.get("argumentHint") or entry.get("argument_hint") or "").strip(),
            }
        )
    commands.sort(key=lambda c: c["name"].lower())
    return commands


# ---------------------------------------------------------------------------
# Live progress of subagents
#
# The CLI streams the main conversation, but nothing at all from inside an Agent
# tool call — verified against a running session: 150 seconds of a busy pipeline
# produced zero events while its subagents were writing to disk the whole time.
# A /full-cycle can sit in one such call for hours, and the chat shows nothing
# until the entire turn ends.
#
# What the CLI does do is write every subagent's transcript to
# ~/.claude/projects/<project>/<session id>/subagents/. Tailing those files is
# the only way to watch that work as it happens, so that is what this does: new
# lines in, `agent_activity` events out.
# ---------------------------------------------------------------------------

LIVE_EVENT_BUFFER = int(os.environ.get("LIVE_EVENT_BUFFER", 1500))
ACTIVITY_POLL_SECONDS = float(os.environ.get("ACTIVITY_POLL_SECONDS", 3))
ACTIVITY_EVENTS_PER_POLL = 40  # a burst cap, so a fast fan-out can't flood the UI
CLAUDE_PROJECTS_DIR = Path(
    os.environ.get("CLAUDE_PROJECTS_DIR") or Path.home() / ".claude" / "projects"
)


def _subagents_dir(session_id: str) -> Path | None:
    """Locate a session's subagent transcripts.

    Found by globbing rather than by deriving the project folder's name from the
    cwd: that name is an encoding of the path whose rules are the CLI's business,
    and a session id is unique enough to search for.
    """
    for path in CLAUDE_PROJECTS_DIR.glob(f"*/{session_id}/subagents"):
        if path.is_dir():
            return path
    return None


# ---------------------------------------------------------------------------
# Context window usage
#
# How full the model's context window is right now, for the gauge next to the
# model picker. A ResultMessage's `usage` gives this live while a turn is
# running; for a chat that has not run a turn since the backend last started,
# the same number is recovered from the CLI's own transcript on disk (the same
# file the CLI itself replays a resumed session from).
# ---------------------------------------------------------------------------

CONTEXT_LIMIT_DEFAULT = 200_000
CONTEXT_LIMIT_1M = 1_000_000


def context_limit_for_model(model: str | None) -> int:
    if model and "1m" in model.lower():
        return CONTEXT_LIMIT_1M
    return CONTEXT_LIMIT_DEFAULT


def context_tokens_from_usage(usage: dict | None) -> int | None:
    if not isinstance(usage, dict):
        return None
    return (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
    )


def _transcript_path(session_id: str) -> Path | None:
    for path in CLAUDE_PROJECTS_DIR.glob(f"*/{session_id}.jsonl"):
        if path.is_file():
            return path
    return None


def last_context_usage(session_id: str | None) -> dict | None:
    """The usage block of the most recent assistant turn in `session_id`'s
    transcript, read straight off disk. Scans from the end so a long-running
    chat's transcript doesn't have to be read in full."""
    if not session_id:
        return None
    path = _transcript_path(session_id)
    if path is None:
        return None

    try:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            block = 65536
            data = b""
            pos = size
            while pos > 0 and len(data) < 2_000_000:
                read_size = min(block, pos)
                pos -= read_size
                f.seek(pos)
                data = f.read(read_size) + data
                for line in reversed(data.split(b"\n")):
                    line = line.strip()
                    if not line or b'"usage"' not in line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("type") != "assistant":
                        continue
                    usage = entry.get("message", {}).get("usage")
                    if usage:
                        return usage
    except OSError:
        return None
    return None


def _tool_detail(tool: str, payload: object) -> str:
    """The one field of a tool's input worth showing next to its name."""
    if not isinstance(payload, dict):
        return ""
    for key in ("command", "file_path", "path", "pattern", "url", "description", "prompt", "query"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:160]
    return ""


def _activity_from_entry(entry: dict) -> list[dict]:
    """The reportable parts of one transcript line: tool calls and finished text."""
    message = entry.get("message") or {}
    content = message.get("content")
    if entry.get("type") != "assistant" or not isinstance(content, list):
        return []

    out = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_use":
            out.append(
                {
                    "kind": "tool",
                    "tool": block.get("name") or "",
                    "detail": _tool_detail(block.get("name") or "", block.get("input")),
                }
            )
        elif block.get("type") == "text":
            text = " ".join(str(block.get("text") or "").split())
            if text:
                out.append({"kind": "text", "tool": "", "detail": text[:200]})
    return out


class SubagentWatcher:
    """Tails one session's subagent transcripts and turns them into events.

    Files already on disk when a turn starts belong to earlier work, so the first
    scan only records their sizes; everything appended after that is new. Files
    that appear later are read from the beginning — they *are* the new work.
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.directory: Path | None = None
        self.offsets: dict[Path, int] = {}
        self.meta: dict[str, dict] = {}
        self.primed = False

    def poll(self) -> list[dict]:
        """Blocking: read whatever is new. Called in a thread."""
        if self.directory is None:
            self.directory = _subagents_dir(self.session_id)
            if self.directory is None:
                return []

        events: list[dict] = []
        for path in sorted(self.directory.glob("agent-*.jsonl")):
            try:
                size = path.stat().st_size
            except OSError:
                continue

            if path not in self.offsets:
                self.offsets[path] = size if not self.primed else 0
            if size <= self.offsets[path]:
                self.offsets[path] = min(self.offsets[path], size)  # truncated/rewritten
                continue

            try:
                with path.open("r", encoding="utf-8", errors="replace") as handle:
                    handle.seek(self.offsets[path])
                    chunk = handle.read()
                    self.offsets[path] = handle.tell()
            except OSError:
                continue

            events.extend(self._parse(path, chunk))

        self.primed = True
        return events[-ACTIVITY_EVENTS_PER_POLL:]

    def _parse(self, path: Path, chunk: str) -> list[dict]:
        agent_id = path.stem
        meta = self._meta_for(path, agent_id)
        events = []
        for line in chunk.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue  # a half-written last line — its offset is already past it
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            for activity in _activity_from_entry(entry):
                events.append(
                    {
                        "type": "agent_activity",
                        "agent_id": agent_id,
                        "agent_type": meta.get("agentType") or "agent",
                        "description": meta.get("description") or "",
                        "depth": meta.get("spawnDepth"),
                        **activity,
                    }
                )
        return events

    def _meta_for(self, path: Path, agent_id: str) -> dict:
        if agent_id not in self.meta:
            meta_path = path.with_suffix(".meta.json")
            try:
                self.meta[agent_id] = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self.meta[agent_id] = {}
        return self.meta[agent_id]


class ChatSession:
    """A long-lived `claude` session for one chat.

    The SDK client stays connected across turns, which is what makes stopping
    possible at all: interrupt() aborts the turn in progress rather than killing
    a process and losing the conversation with it.

    Only one prompt is ever handed to the CLI at a time. Anything typed while it
    works waits in `pending` and is sent when the turn before it ends — the same
    arrangement Claude Code itself uses, and the reason Stop can mean *stop*: a
    prompt the CLI has not been given yet can still be thrown away. Handing them
    over as they were typed would queue them inside the CLI, where nothing can
    reach them, and the run would carry on after every interrupt.

    The invariant everything hangs off is that the CLI emits exactly one
    ResultMessage per query(), *including* interrupted ones (verified against the
    CLI, not assumed). So `active` — the prompt whose result is still owed — is
    also the busy flag.

    Messages are written to the DB only when their turn completes, so a queued
    message can't land in the transcript ahead of the answer to the turn it was
    typed during. Until then it lives purely in the event stream.
    """

    def __init__(
        self,
        chat_id: int,
        group_name: str,
        cwd: Path,
        full_access: bool,
        resume_session_id: str | None,
        chat_title: str = "",
        model: str | None = None,
        effort: str | None = None,
    ):
        self.chat_id = chat_id
        self.group_name = group_name
        self.chat_title = chat_title
        self.cwd = cwd
        self.full_access = full_access
        self.resume_session_id = resume_session_id
        # Both are fixed when the CLI starts, so changing either means dropping the
        # session; it resumes from session_id, so the conversation survives.
        self.model = model
        self.effort = effort

        self.client: sdk.ClaudeSDKClient | None = None
        self.pump_task: asyncio.Task | None = None
        self.lock = asyncio.Lock()  # serialises connect / query / interrupt

        self.active: str | None = None  # handed to the CLI, result still owed
        self.pending: deque[str] = deque()  # typed since, not handed over yet
        self.assistant_text = ""  # text deltas accumulated for the current turn
        self.interrupting = False  # an interrupt was requested for the current turn
        self.subscribers: set[asyncio.Queue] = set()
        self.last_activity = 0.0

        # Everything emitted for the run in progress, replayed to whoever subscribes
        # next. Without it a window reopened (or reloaded) mid-run shows an empty
        # chat: nothing is written to the DB until the turn ends, and a long one can
        # take hours. Bounded because a fan-out of subagents is chatty.
        self.live_events: deque[dict] = deque(maxlen=LIVE_EVENT_BUFFER)
        self.current_session_id: str | None = resume_session_id
        self.activity_task: asyncio.Task | None = None

        self._touch()

    # -- event fan-out -----------------------------------------------------

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)

    def emit(self, event: dict) -> None:
        # run_state is a snapshot, not history: every subscriber is sent a current
        # one anyway, and replaying stale ones would flip the UI in and out of
        # "running" as it catches up. session_gone is addressed to the open event
        # streams, not to the transcript, so it is not history either.
        if event.get("type") not in ("run_state", SESSION_GONE):
            self.live_events.append(event)
        for queue in list(self.subscribers):
            queue.put_nowait(event)

    def replay(self) -> list[dict]:
        """The run in progress so far, for a client that just connected."""
        return list(self.live_events)

    def run_state(self) -> dict:
        return {
            "type": "run_state",
            "running": self.active is not None,
            "pending": (1 if self.active is not None else 0) + len(self.pending),
            "queued": list(self.pending),
            "stopping": self.interrupting,
        }

    def _touch(self) -> None:
        try:
            self.last_activity = asyncio.get_running_loop().time()
        except RuntimeError:
            self.last_activity = 0.0

    @property
    def busy(self) -> bool:
        return self.active is not None or bool(self.pending)

    @property
    def idle_seconds(self) -> float:
        try:
            return asyncio.get_running_loop().time() - self.last_activity
        except RuntimeError:
            return 0.0

    # -- permissions -------------------------------------------------------

    async def _can_use_tool(self, tool_name, tool_input, context):
        if tool_name == QUESTION_TOOL:
            return await _ask_questions(tool_input, self.emit)

        request_id = str(uuid.uuid4())
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        pending_permissions[request_id] = future

        self.emit(
            {
                "type": "permission_request",
                "request_id": request_id,
                "tool_name": tool_name,
                "tool_input": tool_input,
                "title": getattr(context, "title", None),
                "description": getattr(context, "description", None),
            }
        )

        try:
            decision = await asyncio.wait_for(future, timeout=PERMISSION_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            decision = "deny"
        finally:
            pending_permissions.pop(request_id, None)

        self.emit({"type": "permission_resolved", "request_id": request_id, "decision": decision})

        if decision == "allow":
            return sdk.PermissionResultAllow(behavior="allow")
        return sdk.PermissionResultDeny(behavior="deny", message="Denied by user")

    # -- lifecycle ---------------------------------------------------------

    async def _ensure_client(self) -> None:
        """Connect on demand. Opening a chat costs nothing; only sending does."""
        if self.client is not None:
            return

        # The handler is registered even in full-access mode. bypassPermissions
        # auto-approves ordinary tools before the callback is consulted (so no
        # Allow/Deny cards, as intended), but AskUserQuestion is only *offered* to
        # the model when a permission handler exists — with can_use_tool=None the
        # CLI drops the tool entirely and the agent silently loses the ability to
        # ask. Registering it is what keeps question cards working everywhere.
        # Project memory rides along as an in-process MCP server. It is pre-approved
        # in allowed_tools so reading the project's own history never raises a
        # permission card — there is nothing to approve, and asking on every lookup
        # would train the user to click through prompts that do matter.
        mcp_servers = {}
        extra_tools: list[str] = []
        append_prompt = ""
        if memory.store.enabled:
            mcp_servers[MEMORY_SERVER] = sdk.create_sdk_mcp_server(
                name=MEMORY_SERVER, tools=_memory_tools(self)
            )
            extra_tools = list(MEMORY_TOOLS)
            append_prompt = MEMORY_PROMPT

        options = sdk.ClaudeAgentOptions(
            cwd=str(self.cwd),
            permission_mode="bypassPermissions" if self.full_access else "default",
            can_use_tool=self._can_use_tool,
            include_partial_messages=True,
            mcp_servers=mcp_servers,
            allowed_tools=extra_tools,
            # The preset keeps the CLI's own Claude Code prompt and appends to it;
            # leaving system_prompt unset would send `--system-prompt ""` instead.
            system_prompt=(
                {"type": "preset", "preset": "claude_code", "append": append_prompt}
                if append_prompt
                else None
            ),
            # The SDK reads the CLI's stdout as one JSON message per line and
            # refuses any line over this limit (1MB by default), which a single
            # fat tool result — a big file read, a screenshot, a long grep — blows
            # right through. The failure is not recoverable mid-turn: it surfaces
            # as a decode error in _pump and takes the whole session down with it.
            max_buffer_size=MAX_BUFFER_SIZE,
            # None on either means "whatever the CLI is configured to use".
            model=self.model,
            effort=self.effort,
            resume=self.resume_session_id,
        )
        client = sdk.ClaudeSDKClient(options=options)
        await client.connect()
        self.client = client
        self.pump_task = asyncio.create_task(self._pump(client))
        logger.info("chat %d: session connected (resume=%s)", self.chat_id, self.resume_session_id)

    async def _pump(self, client: sdk.ClaudeSDKClient) -> None:
        """Fan every message from the CLI out to subscribers, and close out turns."""
        try:
            async for message in client.receive_messages():
                self._touch()
                event = _serialize(message)

                # The id the CLI is actually using this turn — a resumed session
                # gets a fresh one, and it is what names the transcript folder the
                # subagent watcher tails.
                if event.get("session_id"):
                    self.current_session_id = event["session_id"]

                if event["type"] == "stream_event":
                    inner = event.get("event") or {}
                    if inner.get("type") == "content_block_delta":
                        delta = inner.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            self.assistant_text += delta.get("text", "")

                self.emit(event)

                if isinstance(message, sdk.ResultMessage):
                    await self._finish_turn(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface any SDK/transport failure to the UI
            logger.exception("chat %d: session pump failed", self.chat_id)
            self.emit({"type": "process_error", "reason": "internal_error", "detail": str(exc)})
            await asyncio.to_thread(
                db.add_message, self.chat_id, "error", f"[session error] {exc}"
            )
            self._discard_client(reason="pump failed")

    async def _finish_turn(self, message: sdk.ResultMessage) -> None:
        """One result arrived: persist that turn and hand over to the next one."""
        prompt, self.active = self.active, None
        final_text = message.result or self.assistant_text
        self.assistant_text = ""
        stopped = self.interrupting
        self.interrupting = False

        if message.session_id:
            self.resume_session_id = message.session_id
            await asyncio.to_thread(db.update_chat_session, self.chat_id, message.session_id)

        if prompt is not None:
            await asyncio.to_thread(db.add_message, self.chat_id, "user", prompt)

        if stopped:
            # An interrupt yields subtype='error_during_execution' with an empty
            # result, so whatever was streamed before the stop is all we have.
            if (final_text or "").strip():
                await asyncio.to_thread(db.add_message, self.chat_id, "assistant", final_text)
            await asyncio.to_thread(db.add_message, self.chat_id, "error", "⏹ Stopped by you")
        elif message.is_error:
            await asyncio.to_thread(
                db.add_message, self.chat_id, "error", final_text or f"[{message.subtype}]"
            )
        elif (final_text or "").strip():
            message_id = await asyncio.to_thread(
                db.add_message, self.chat_id, "assistant", final_text
            )
            # Only turns that ran to a clean finish are worth remembering — an
            # interrupted or failed one describes work that never happened.
            asyncio.create_task(
                self._remember_turn(prompt or "", final_text, message_id)
            )

        # Nothing was queued inside the CLI, so the next prompt has to be handed
        # over here. As its own task: this runs on the pump, and the lock it takes
        # is one send() holds while awaiting the CLI.
        if self.pending:
            asyncio.create_task(self._start_next())
        else:
            self._stop_activity_watch()
            # The turn just persisted to the DB is now available from there, so
            # replaying it to the next subscriber would only duplicate what
            # renderMessages() already draws from storage.
            self.live_events.clear()

        self.emit(self.run_state())

    async def _start_next(self) -> None:
        """Hand the oldest waiting prompt to the CLI, if one is still waiting."""
        async with self.lock:
            if self.active is not None or not self.pending or self.client is None:
                return  # stopped, drained, or the session went away meanwhile
            text = self.pending.popleft()
            self.active = text
            self.emit({"type": "turn_start", "content": text})
            self.emit(self.run_state())
            try:
                await self.client.query(text)
            except Exception:  # noqa: BLE001 - surfaced to the UI, not swallowed
                logger.exception("chat %d: failed to start the next turn", self.chat_id)
                self.active = None
                self.emit({"type": "process_error", "reason": "query_failed", "detail": text})
                self.emit(self.run_state())

    async def _remember_turn(self, prompt: str, answer: str, message_id: int) -> None:
        """Index a finished turn into the project's memory, off the turn's path.

        Runs as its own task: embedding takes a moment, and nothing about the chat
        should wait on it — a failure here costs a log line, not a reply.
        """
        try:
            title = await asyncio.to_thread(db.get_chat, self.chat_id)
            if title:
                self.chat_title = title.get("title") or self.chat_title
            stored = await memory.store.remember_turn(
                group_name=self.group_name,
                chat_id=self.chat_id,
                chat_title=self.chat_title,
                prompt=prompt,
                answer=answer,
                message_id=message_id,
            )
            if stored:
                self.emit({"type": "memory_indexed", "chat_id": self.chat_id, "chunks": stored})
        except Exception:  # noqa: BLE001 - memory must never break a chat
            logger.exception("chat %d: failed to index turn into memory", self.chat_id)

    # -- subagent progress -------------------------------------------------

    def _start_activity_watch(self) -> None:
        if self.activity_task is None or self.activity_task.done():
            self.activity_task = asyncio.create_task(self._watch_subagents())

    def _stop_activity_watch(self) -> None:
        task, self.activity_task = self.activity_task, None
        if task is not None:
            task.cancel()

    async def _watch_subagents(self) -> None:
        """Report what the turn's subagents are doing, for as long as it runs."""
        watcher: SubagentWatcher | None = None
        try:
            while True:
                await asyncio.sleep(ACTIVITY_POLL_SECONDS)
                session_id = self.current_session_id
                if not session_id:
                    continue  # the CLI has not announced the turn's session yet
                if watcher is None or watcher.session_id != session_id:
                    watcher = SubagentWatcher(session_id)
                for event in await asyncio.to_thread(watcher.poll):
                    self.emit(event)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - progress reporting must never break a turn
            logger.exception("chat %d: subagent watch failed", self.chat_id)

    def _discard_client(self, reason: str) -> None:
        """Drop a broken client without awaiting inside the pump that owns it."""
        client, self.client = self.client, None
        self.pump_task = None
        self.active = None
        self.pending.clear()
        self.assistant_text = ""
        self.interrupting = False
        self._stop_activity_watch()
        if client is not None:
            asyncio.create_task(self._disconnect(client, reason))
        self.emit(self.run_state())

    async def _disconnect(self, client: sdk.ClaudeSDKClient, reason: str) -> None:
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001 - best-effort teardown
            logger.debug("chat %d: disconnect after %s failed", self.chat_id, reason, exc_info=True)

    # -- the three things the API can do -----------------------------------

    async def send(self, text: str) -> bool:
        """Take a message. Returns True if it had to wait for the running turn."""
        async with self.lock:
            await self._ensure_client()
            self._touch()

            if self.active is not None:
                # Held here, not handed to the CLI: that is what makes it possible
                # to drop it again when the user hits Stop.
                self.pending.append(text)
                self.emit({"type": "turn_queued", "content": text})
                self.emit(self.run_state())
                return True

            # A new run: the previous one's trace is in the DB by now, and keeping
            # it would replay a finished conversation over the new one.
            self.live_events.clear()
            self._start_activity_watch()
            self.active = text

            # Announced before query() so the message is on screen ahead of any
            # output the CLI produces for it.
            self.emit({"type": "turn_start", "content": text})
            self.emit(self.run_state())

            try:
                await self.client.query(text)
            except Exception:
                self.active = None
                self.emit(self.run_state())
                raise

            return False

    async def interrupt(self) -> bool:
        """Stop: abort the running turn and drop everything waiting behind it."""
        async with self.lock:
            if self.client is None or not self.busy:
                return False

            dropped = list(self.pending)
            self.pending.clear()
            if dropped:
                self.emit({"type": "turns_dropped", "contents": dropped})

            self._touch()
            if self.active is None:
                # Only queued work existed; there is no turn to abort.
                self.emit(self.run_state())
                return True

            self.interrupting = True
            self.emit(self.run_state())  # tells the UI the stop was taken
            await self.client.interrupt()
            return True

    async def aclose(self) -> None:
        task, self.pump_task = self.pump_task, None
        client, self.client = self.client, None
        self.active = None
        self.pending.clear()
        self.assistant_text = ""
        self.interrupting = False
        self._stop_activity_watch()
        if task is not None:
            task.cancel()
        if client is not None:
            await self._disconnect(client, "close")


# ---------------------------------------------------------------------------
# Session registry
# ---------------------------------------------------------------------------

_sessions: dict[int, ChatSession] = {}


def get_session(
    chat_id: int,
    group_name: str,
    cwd: Path,
    full_access: bool,
    resume_session_id: str | None,
    chat_title: str = "",
    model: str | None = None,
    effort: str | None = None,
) -> ChatSession:
    """Return (creating if needed) the session for a chat. Cheap: no subprocess
    is started until the first message is actually sent."""
    session = _sessions.get(chat_id)
    if session is None:
        session = ChatSession(
            chat_id, group_name, cwd, full_access, resume_session_id, chat_title, model, effort
        )
        _sessions[chat_id] = session
    elif chat_title:
        session.chat_title = chat_title  # a renamed chat labels its memory correctly
    return session


def peek_session(chat_id: int) -> ChatSession | None:
    return _sessions.get(chat_id)


async def close_session(chat_id: int) -> None:
    session = _sessions.pop(chat_id, None)
    if session is not None:
        # This object is out of the registry, so the next message builds a new one
        # and emits to *its* subscribers. Anyone listening here has to follow.
        session.emit({"type": SESSION_GONE})
        await session.aclose()


async def close_all_sessions() -> None:
    for chat_id in list(_sessions):
        await close_session(chat_id)


# ---------------------------------------------------------------------------
# Slash commands
#
# The CLI reports every command it would offer in that project — built-ins plus
# whatever the project's .claude/commands, the user's own, plugins and skills
# contribute — in the handshake it sends on connect. So the list is read from a
# real session for the project rather than guessed from the filesystem, and is
# cached per project because it only changes when the command files do.
# ---------------------------------------------------------------------------

_commands_cache: dict[str, list[dict]] = {}
_commands_locks: dict[str, asyncio.Lock] = {}


async def _fetch_server_info(cwd: Path, full_access: bool, want: str) -> dict:
    """The CLI's handshake for `cwd` — what it offers, straight from the CLI.

    `want` names the key the caller needs, so a session whose handshake happens
    not to carry it doesn't count as an answer.
    """
    # A chat already running in this project has the handshake in hand: free.
    for session in _sessions.values():
        if str(session.cwd) == str(cwd) and session.client is not None:
            info = await session.client.get_server_info() or {}
            if info.get(want):
                return info

    # Otherwise open a throwaway session just to read its handshake. Nothing is
    # queried on it, so no turn runs and no tool can fire.
    options = sdk.ClaudeAgentOptions(
        cwd=str(cwd),
        permission_mode="bypassPermissions" if full_access else "default",
        max_buffer_size=MAX_BUFFER_SIZE,
    )
    client = sdk.ClaudeSDKClient(options=options)
    await client.connect()
    try:
        return await client.get_server_info() or {}
    finally:
        await client.disconnect()


async def list_commands(cwd: Path, full_access: bool, refresh: bool = False) -> list[dict]:
    """Slash commands available to agents running in `cwd`."""
    key = str(cwd)
    if not refresh and key in _commands_cache:
        return _commands_cache[key]

    lock = _commands_locks.setdefault(key, asyncio.Lock())
    async with lock:  # concurrent openers of the same group share one probe
        if not refresh and key in _commands_cache:
            return _commands_cache[key]
        commands = _normalize_commands(await _fetch_server_info(Path(cwd), full_access, "commands"))
        _commands_cache[key] = commands
        logger.info("%s: %d slash command(s) available", key, len(commands))
        return commands


_models_cache: dict[str, list[dict]] = {}
_models_locks: dict[str, asyncio.Lock] = {}

# Pinned model snapshots reachable by giving the CLI a full model ID (its /model
# command accepts one even though its own picker doesn't list it) — the picker
# only ever offers the current generation. Listed here by hand since there is no
# handshake field for "other IDs the CLI happens to accept"; add more as needed.
EXTRA_MODELS = [
    {
        "value": "claude-opus-4-6",
        "label": "Opus 4.6",
        "description": "Pinned snapshot, previous generation",
        "efforts": ["low", "medium", "high", "xhigh", "max"],
    },
    {
        "value": "claude-opus-4-8",
        "label": "Opus 4.8",
        "description": "Pinned snapshot, previous generation",
        "efforts": ["low", "medium", "high", "xhigh", "max"],
    },
]


def _normalize_models(info: dict | None) -> list[dict]:
    """The models the CLI offers, with the effort levels each one accepts.

    Read from the handshake rather than hardcoded: which models exist, and which
    of them support effort at all, is the CLI's business and changes with it.
    EXTRA_MODELS is folded in afterwards, skipping anything the handshake already
    listed under the same id.
    """
    models = []
    for entry in (info or {}).get("models") or []:
        if not isinstance(entry, dict) or not entry.get("value"):
            continue
        models.append(
            {
                "value": entry["value"],
                "label": entry.get("displayName") or entry["value"],
                "description": entry.get("description") or "",
                "efforts": list(entry.get("supportedEffortLevels") or []),
            }
        )

    known = {m["value"] for m in models}
    models.extend(m for m in EXTRA_MODELS if m["value"] not in known)
    return models


async def list_models(cwd: Path, full_access: bool, refresh: bool = False) -> list[dict]:
    """Models a chat in this project can be switched to."""
    key = str(cwd)
    if not refresh and key in _models_cache:
        return _models_cache[key]

    lock = _models_locks.setdefault(key, asyncio.Lock())
    async with lock:
        if not refresh and key in _models_cache:
            return _models_cache[key]
        models = _normalize_models(await _fetch_server_info(Path(cwd), full_access, "models"))
        _models_cache[key] = models
        logger.info("%s: %d model(s) offered", key, len(models))
        return models


async def reap_idle_sessions(interval: int = 60) -> None:
    """Background loop: hang up on sessions nobody is using, so a long-running
    orchestrator doesn't accumulate one `claude` subprocess per chat ever opened."""
    while True:
        await asyncio.sleep(interval)
        for chat_id, session in list(_sessions.items()):
            if session.busy or session.subscribers or session.client is None:
                continue
            if session.idle_seconds > SESSION_IDLE_SECONDS:
                logger.info("chat %d: closing idle session", chat_id)
                await close_session(chat_id)
