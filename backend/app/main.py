from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import db, memory, report
from app.config import GroupConfig, append_group, load_groups, load_memory
from app.runner import (
    SESSION_GONE,
    close_all_sessions,
    close_session,
    context_limit_for_model,
    context_tokens_from_usage,
    get_session,
    last_context_usage,
    list_commands,
    list_models,
    peek_session,
    pending_permissions,
    pending_questions,
    reap_idle_sessions,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="agents-orchestrator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

groups: list[GroupConfig] = load_groups(os.environ.get("CONFIG_PATH"))
groups_by_name: dict[str, GroupConfig] = {g.name: g for g in groups}
memory_store = memory.configure(load_memory(os.environ.get("CONFIG_PATH")))

# How long a chat's event stream may sit silent before we send a comment frame,
# so an idle connection isn't mistaken for a dead one.
KEEPALIVE_SECONDS = 20

# Where files attached to a chat are stored before the agent reads them. Kept out
# of the project folders so an upload never dirties a repo; the agent is handed
# the absolute path and reads it with its Read tool. One subfolder per chat, so a
# deleted chat can take its uploads with it.
UPLOADS_DIR = Path(
    os.environ.get("UPLOADS_DIR") or (Path(__file__).resolve().parent.parent.parent / "data" / "uploads")
)
MAX_ATTACHMENT_BYTES = int(os.environ.get("MAX_ATTACHMENT_BYTES", 32 * 1024 * 1024))


def _safe_filename(name: str) -> str:
    """A filesystem-friendly version of an uploaded file's name, never empty."""
    base = os.path.basename(name or "").strip()
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    return cleaned[:120] or "file"


@app.on_event("startup")
async def on_startup() -> None:
    db.init_db()
    asyncio.create_task(reap_idle_sessions())
    # Connecting to Qdrant means loading the embedding model, which on the very
    # first run downloads it. Done in the background so the UI comes up either
    # way: if it fails, chats work and only memory is missing.
    asyncio.create_task(memory_store.ensure_ready())
    logger.info("Loaded %d group(s): %s", len(groups), ", ".join(g.name for g in groups))


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await close_all_sessions()


def _require_group(name: str) -> GroupConfig:
    group = groups_by_name.get(name)
    if group is None:
        raise HTTPException(status_code=404, detail=f"Unknown group '{name}'")
    return group


def _require_chat(chat_id: int) -> dict:
    chat = db.get_chat(chat_id)
    if chat is None:
        raise HTTPException(status_code=404, detail=f"Unknown chat {chat_id}")
    return chat


@app.get("/health")
async def health():
    return {"status": "ok", "groups": [g.name for g in groups], "memory": memory_store.status()}


@app.get("/groups")
async def list_groups():
    return [{"name": g.name, "path": str(g.path), "full_access": g.full_access} for g in groups]


class AddGroupRequest(BaseModel):
    path: str
    name: str | None = None  # defaults to the folder's own name
    full_access: bool = False


@app.post("/groups")
async def add_group(body: AddGroupRequest):
    """Add a project folder as a group, without a restart.

    Written to config.yaml *and* registered in memory: the file is what survives
    a restart, the in-memory list is what makes the group usable right away.
    """
    path = Path(body.path).expanduser()
    if not path.is_dir():
        # In the containerised setup this is the container's view of the
        # filesystem, which is why the mount matters more than the host path.
        raise HTTPException(status_code=400, detail=f"Not a directory here: {path}")

    name = (body.name or path.name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name must not be empty")
    if name in groups_by_name:
        raise HTTPException(status_code=409, detail=f"Group '{name}' already exists")
    if any(g.path == path for g in groups):
        raise HTTPException(status_code=409, detail=f"That folder is already a group: {path}")

    try:
        group = await asyncio.to_thread(
            append_group, name, path, body.full_access, os.environ.get("CONFIG_PATH")
        )
    except Exception as exc:  # noqa: BLE001 - a bad write must not take the server down
        logger.exception("failed to add group %s", name)
        raise HTTPException(status_code=500, detail=f"Could not write config.yaml: {exc}") from exc

    groups.append(group)
    groups_by_name[group.name] = group
    logger.info("added group %s -> %s (full_access=%s)", group.name, group.path, group.full_access)
    return {"name": group.name, "path": str(group.path), "full_access": group.full_access}


@app.get("/groups/{name}/chats")
async def list_chats(name: str):
    _require_group(name)
    return await asyncio.to_thread(db.list_chats, name)


@app.get("/groups/{name}/commands")
async def list_group_commands(name: str, refresh: bool = False):
    """The slash commands `claude` offers in this group's project folder.

    Read from the CLI itself, so it is exactly what the agent would accept:
    project commands, the user's own, plugin and skill ones, and built-ins.
    """
    group = _require_group(name)
    try:
        return await list_commands(group.path, group.full_access, refresh)
    except Exception as exc:  # noqa: BLE001 - a probe failure must not break the UI
        logger.exception("group %s: failed to list commands", name)
        raise HTTPException(status_code=502, detail=f"Could not read commands: {exc}") from exc


@app.get("/groups/{name}/models")
async def list_group_models(name: str, refresh: bool = False):
    """The models a chat in this project can run on, as the CLI reports them."""
    group = _require_group(name)
    try:
        return await list_models(group.path, group.full_access, refresh)
    except Exception as exc:  # noqa: BLE001 - a probe failure must not break the UI
        logger.exception("group %s: failed to list models", name)
        raise HTTPException(status_code=502, detail=f"Could not read models: {exc}") from exc


class CreateChatRequest(BaseModel):
    title: str | None = None


@app.post("/groups/{name}/chats")
async def create_chat(name: str, body: CreateChatRequest):
    _require_group(name)
    title = body.title or "New chat"
    chat_id = await asyncio.to_thread(db.create_chat, name, title)
    return db.get_chat(chat_id)


class UpdateChatRequest(BaseModel):
    title: str | None = None
    # Present-but-null clears the choice, i.e. falls back to the CLI's default;
    # absent leaves whatever the chat already has.
    model: str | None = None
    effort: str | None = None


@app.patch("/chats/{chat_id}")
async def update_chat(chat_id: int, body: UpdateChatRequest):
    """Rename a chat, or change the model and effort its agent runs with.

    A title is safe against the auto-titling in post_message: that one only fills
    in chats still sitting at the default "New chat".

    Model and effort are fixed when the CLI process starts, so switching them
    ends the session. That costs nothing but a reconnect — the next message
    resumes from the stored session id, with the conversation intact — but it
    cannot be done under a running turn, hence the 409.
    """
    chat = _require_chat(chat_id)
    fields = body.model_dump(exclude_unset=True)

    if "title" in fields:
        title = (body.title or "").strip()[:80]
        if not title:
            raise HTTPException(status_code=400, detail="Title must not be empty")
        await asyncio.to_thread(db.update_chat_title, chat_id, title)

    if "model" in fields or "effort" in fields:
        session = peek_session(chat_id)
        if session is not None and session.busy:
            raise HTTPException(status_code=409, detail="Stop the current turn first")
        model = body.model if "model" in fields else chat["model"]
        effort = body.effort if "effort" in fields else chat["effort"]
        await asyncio.to_thread(db.update_chat_model, chat_id, model, effort)
        await close_session(chat_id)  # reopens with the new options on the next message

    return db.get_chat(chat_id)


@app.delete("/chats/{chat_id}")
async def remove_chat(chat_id: int):
    _require_chat(chat_id)
    await close_session(chat_id)
    await asyncio.to_thread(db.delete_chat, chat_id)
    # A deleted chat must not keep answering searches from the chats that outlive it.
    await memory_store.forget_chat(chat_id)
    # Its uploaded files go with it — nothing else can reach them now.
    await asyncio.to_thread(shutil.rmtree, UPLOADS_DIR / str(chat_id), True)
    return {"deleted": True}


@app.get("/chats/{chat_id}/messages")
async def get_messages(chat_id: int):
    _require_chat(chat_id)
    return await asyncio.to_thread(db.list_messages, chat_id)


@app.get("/chats/{chat_id}/context")
async def get_context_usage(chat_id: int):
    """How full this chat's context window is right now, straight off its
    transcript — the same number a live `result` event carries while a turn is
    running, recovered here for a chat that hasn't had one yet this session."""
    chat = _require_chat(chat_id)
    limit = context_limit_for_model(chat["model"])
    usage = await asyncio.to_thread(last_context_usage, chat["session_id"])
    tokens = context_tokens_from_usage(usage)
    if tokens is None:
        return {"tokens": None, "limit": limit, "pct": None}
    return {"tokens": tokens, "limit": limit, "pct": round(100 * tokens / limit)}


@app.post("/chats/{chat_id}/attachments")
async def upload_attachment(chat_id: int, file: UploadFile = File(...)):
    """Store a file attached to a chat and return the absolute path to read it at.

    The composer embeds that path in the message it sends, so the agent picks the
    file up with its Read tool. Saving is all that happens here — nothing is sent
    to the agent until the message itself is posted.
    """
    _require_chat(chat_id)

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The file is empty")
    if len(data) > MAX_ATTACHMENT_BYTES:
        limit = MAX_ATTACHMENT_BYTES // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"File too large (max {limit} MB)")

    dest_dir = UPLOADS_DIR / str(chat_id)
    await asyncio.to_thread(dest_dir.mkdir, parents=True, exist_ok=True)
    # A random prefix keeps two files of the same name from colliding while still
    # preserving the original name for the agent (and the user) to see.
    stored = f"{uuid.uuid4().hex}_{_safe_filename(file.filename)}"
    dest = dest_dir / stored
    await asyncio.to_thread(dest.write_bytes, data)

    return {
        "path": str(dest),
        "name": os.path.basename(file.filename or "") or _safe_filename(file.filename),
        "size": len(data),
    }


class PostMessageRequest(BaseModel):
    content: str


def _session_for(chat_id: int):
    chat = _require_chat(chat_id)
    group = _require_group(chat["group_name"])
    session = get_session(
        chat_id,
        group.name,
        group.path,
        group.full_access,
        chat["session_id"],
        chat["title"],
        chat["model"],
        chat["effort"],
    )
    return chat, session


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


@app.post("/chats/{chat_id}/messages")
async def post_message(chat_id: int, body: PostMessageRequest):
    """Hand a message to the chat's session and return immediately.

    Output is not carried on this response — it goes to /chats/{id}/events, which
    stays open across turns. That separation is what lets a message be sent while
    the agent is still working: it waits its turn in the session and the
    already-open event stream reports it, first as queued and then as sent.
    """
    chat, session = _session_for(chat_id)

    if chat["title"] == "New chat" and not session.busy:
        existing = await asyncio.to_thread(db.list_messages, chat_id)
        if not existing:
            title = body.content.strip().splitlines()[0][:80] or "New chat"
            await asyncio.to_thread(db.update_chat_title, chat_id, title)

    try:
        queued = await session.send(body.content)
    except Exception as exc:  # noqa: BLE001 - the CLI failing to start is a 502, not a crash
        logger.exception("chat %d: failed to send message", chat_id)
        raise HTTPException(status_code=502, detail=f"Agent session failed: {exc}") from exc

    return {"ok": True, "queued": queued, "pending": session.run_state()["pending"]}


@app.get("/chats/{chat_id}/events")
async def chat_events(chat_id: int):
    """Everything the agent emits for this chat, for as long as the client listens.

    Opening this does not start an agent — sessions connect lazily on the first
    message. The first frame is always a run_state snapshot, so a client that
    attaches mid-run (or reconnects after a reload) learns where things stand,
    and everything the run has emitted so far follows it: until a turn ends
    nothing of it is in the DB, so replaying is the only way a reopened window
    sees a run that has been going for hours.

    The connection outlives the *session object* too. Changing a chat's model or
    effort retires it, and an idle one is reaped; the replacement fans out to its
    own subscribers, so a stream bound to the old object would go silent for good
    — the "type a message, see nothing until you switch chats and back" bug. A
    SESSION_GONE frame is the signal to rebind, below.
    """
    _session_for(chat_id)  # 404 before the stream opens, not inside it

    async def event_source():
        while True:
            try:
                _chat, session = _session_for(chat_id)
            except HTTPException:
                break  # the chat was deleted under us; nothing left to stream

            queue = session.subscribe()
            # Subscribing first and snapshotting second is what makes the handover
            # lossless; the overlap it costs is an event landing in both, which the
            # identity check below drops. The snapshot is held for as long as this
            # subscription lasts so those ids stay meaningful.
            replayed = session.replay()
            already_sent = {id(event) for event in replayed}
            rebind = False
            try:
                yield _sse(session.run_state())
                for event in replayed:
                    yield _sse(event)
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                    except asyncio.TimeoutError:
                        # Also covers a session swapped out without a SESSION_GONE
                        # reaching us (a torn-down registry, a restart mid-flight).
                        if peek_session(chat_id) not in (None, session):
                            rebind = True
                            break
                        yield ": keepalive\n\n"
                        continue
                    if event.get("type") == SESSION_GONE:
                        rebind = True
                        break
                    if already_sent:
                        if id(event) in already_sent:
                            already_sent.discard(id(event))
                            continue
                        already_sent.clear()  # past the overlap; stop paying for the check
                    yield _sse(event)
            finally:
                session.unsubscribe(queue)

            if not rebind:
                break

    return StreamingResponse(event_source(), media_type="text/event-stream")


@app.post("/chats/{chat_id}/interrupt")
async def interrupt_chat(chat_id: int):
    """Stop: abort the running turn and drop whatever was queued behind it."""
    _chat, session = _session_for(chat_id)
    stopped = await session.interrupt()
    return {"stopped": stopped}


# ---------------------------------------------------------------------------
# Project memory
#
# The same store the agent reaches through its MCP tools, exposed so the user can
# look into it directly — what is remembered about a project, and what an agent
# would find if it searched.
# ---------------------------------------------------------------------------


@app.get("/memory/status")
async def memory_status():
    return memory_store.status()


@app.get("/groups/{name}/memory")
async def memory_overview(name: str):
    _require_group(name)
    return {**memory_store.status(), "points": await memory_store.count(name)}


class MemorySearchRequest(BaseModel):
    query: str
    limit: int = 10
    exclude_chat_id: int | None = None


@app.post("/groups/{name}/memory/search")
async def memory_search(name: str, body: MemorySearchRequest):
    _require_group(name)
    hits = await memory_store.search(
        group_name=name,
        query=body.query,
        limit=max(1, min(body.limit, 50)),
        exclude_chat_id=body.exclude_chat_id,
    )
    return [hit.as_dict() for hit in hits]


class MemoryNoteRequest(BaseModel):
    text: str
    chat_id: int | None = None


@app.post("/groups/{name}/memory/notes")
async def memory_add_note(name: str, body: MemoryNoteRequest):
    """Write a note into a project's memory by hand, without going through an agent."""
    _require_group(name)
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Note must not be empty")
    chat_title = ""
    if body.chat_id is not None:
        chat = db.get_chat(body.chat_id)
        chat_title = (chat or {}).get("title", "")
    stored = await memory_store.remember(
        group_name=name,
        chat_id=body.chat_id,
        chat_title=chat_title or "manual note",
        text=text,
        kind="note",
    )
    if not stored:
        status = memory_store.status()
        raise HTTPException(
            status_code=503,
            detail=status["error"] or "Project memory is disabled or unavailable",
        )
    return {"stored": stored}


# ---------------------------------------------------------------------------
# Work report
#
# A short bullet summary of what was done in the chosen projects over a span of
# days, for retelling at a meeting. Read from the stored chat history.
# ---------------------------------------------------------------------------


class ReportRequest(BaseModel):
    groups: list[str]
    date_from: str  # YYYY-MM-DD, the user's local day
    date_to: str
    tz_offset_minutes: int = 0  # the user's offset from UTC, east positive


@app.post("/report")
async def work_report(body: ReportRequest):
    if not body.groups:
        raise HTTPException(status_code=400, detail="Pick at least one project")
    for name in body.groups:
        _require_group(name)
    try:
        return await report.build_report(
            body.groups, body.date_from, body.date_to, body.tz_offset_minutes
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - a failed CLI call is a 502, not a crash
        logger.exception("work report failed")
        raise HTTPException(status_code=502, detail=f"Could not build the report: {exc}") from exc


class PermissionResponseRequest(BaseModel):
    decision: str  # "allow" or "deny"


@app.post("/permissions/{request_id}/respond")
async def respond_to_permission(request_id: str, body: PermissionResponseRequest):
    future = pending_permissions.get(request_id)
    if future is None:
        raise HTTPException(status_code=404, detail="Unknown or already-resolved permission request")
    if body.decision not in ("allow", "deny"):
        raise HTTPException(status_code=400, detail="decision must be 'allow' or 'deny'")
    if not future.done():
        future.set_result(body.decision)
    return {"ok": True}


class QuestionResponseRequest(BaseModel):
    # question text -> chosen option label (list for multi-select questions)
    answers: dict[str, str | list[str]] = {}
    response: str | None = None  # free-text answer typed instead of picking options
    skipped: bool = False


@app.post("/questions/{request_id}/respond")
async def respond_to_question(request_id: str, body: QuestionResponseRequest):
    future = pending_questions.get(request_id)
    if future is None:
        raise HTTPException(status_code=404, detail="Unknown or already-answered question")
    if not body.skipped and not body.answers and not (body.response or "").strip():
        raise HTTPException(status_code=400, detail="Provide answers, a response, or skipped=true")
    if not future.done():
        future.set_result(None if body.skipped else {"answers": body.answers, "response": body.response})
    return {"ok": True}
