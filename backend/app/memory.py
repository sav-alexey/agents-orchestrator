"""Long-term project memory on top of Qdrant.

Every chat of a project writes its finished turns into one shared collection,
keyed by the group (= project) they belong to. A later chat — a different
`claude` session with none of the earlier transcript in its context — can then
search that collection and pick up what was decided, tried or ruled out before.

Two things go in:

* **turns** — indexed automatically when a turn completes, so the record builds
  itself with nobody having to remember to save anything;
* **notes** — short distilled facts the agent writes on purpose through the
  `save_memory` tool, for things worth surfacing above raw transcript.

Everything here is best-effort. Qdrant being down, slow, or never started must
never break a chat: the calls log and return empty instead of raising.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from app.config import MemoryConfig

logger = logging.getLogger(__name__)

# Deterministic point ids: re-indexing the same turn overwrites its points
# instead of piling up duplicates.
_NAMESPACE = uuid.UUID("6f2a1f4e-9c1b-4f7e-9a2d-0f5c1b7d4a11")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _chunk(text: str, size: int, overlap: int) -> list[str]:
    """Split on paragraph boundaries where possible, hard-cut where not."""
    text = text.strip()
    if len(text) <= size:
        return [text] if text else []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            window = text.rfind("\n\n", start + size // 2, end)
            if window == -1:
                window = text.rfind("\n", start + size // 2, end)
            if window == -1:
                window = text.rfind(" ", start + size // 2, end)
            if window != -1:
                end = window
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return chunks


@dataclass
class MemoryHit:
    text: str
    score: float
    kind: str
    chat_id: int | None
    chat_title: str
    created_at: str

    def as_dict(self) -> dict:
        return {
            "text": self.text,
            "score": round(self.score, 4),
            "kind": self.kind,
            "chat_id": self.chat_id,
            "chat_title": self.chat_title,
            "created_at": self.created_at,
        }


class MemoryStore:
    """One collection for all projects, partitioned by a `group_name` filter.

    Both the Qdrant client and the embedding model are built on first use and
    on a background thread — importing fastembed and loading its ONNX model
    costs a second or two, and the app must not pay that at startup (nor at all
    if memory is switched off).
    """

    def __init__(self, config: MemoryConfig):
        self.config = config
        self._client = None
        self._embedder = None
        self._vector_size = 0
        self._ready = False
        self._failure: str | None = None
        self._lock = asyncio.Lock()

    # -- state -------------------------------------------------------------

    @property
    def enabled(self) -> bool:
        return self.config.enabled

    def status(self) -> dict:
        return {
            "enabled": self.config.enabled,
            "ready": self._ready,
            "url": self.config.url,
            "collection": self.config.collection,
            "embedding_model": self.config.embedding_model,
            "error": self._failure,
        }

    # -- connection --------------------------------------------------------

    def _connect(self) -> None:
        """Blocking setup: model load, connection, collection creation."""
        from fastembed import TextEmbedding
        from qdrant_client import QdrantClient, models

        embedder = TextEmbedding(model_name=self.config.embedding_model)
        vector_size = int(embedder.embedding_size)

        client = QdrantClient(
            url=self.config.url,
            api_key=self.config.api_key,
            timeout=30,
        )

        if not client.collection_exists(self.config.collection):
            client.create_collection(
                collection_name=self.config.collection,
                vectors_config=models.VectorParams(
                    size=vector_size, distance=models.Distance.COSINE
                ),
            )
            logger.info(
                "memory: created collection %s (dim=%d)", self.config.collection, vector_size
            )
        else:
            existing = client.get_collection(self.config.collection)
            params = existing.config.params.vectors
            size = getattr(params, "size", None)
            if size and int(size) != vector_size:
                raise RuntimeError(
                    f"collection '{self.config.collection}' has vector size {size}, but "
                    f"'{self.config.embedding_model}' produces {vector_size}. Point "
                    "memory.collection at a new name, or drop the old collection."
                )

        # Filtering by group/chat without an index is a full scan, and deleting a
        # chat's points needs the chat_id one.
        for field in ("group_name", "kind"):
            client.create_payload_index(
                collection_name=self.config.collection,
                field_name=field,
                field_schema=models.PayloadSchemaType.KEYWORD,
                wait=True,
            )
        client.create_payload_index(
            collection_name=self.config.collection,
            field_name="chat_id",
            field_schema=models.PayloadSchemaType.INTEGER,
            wait=True,
        )

        self._embedder = embedder
        self._client = client
        self._vector_size = vector_size

    async def ensure_ready(self) -> bool:
        if not self.config.enabled:
            return False
        if self._ready:
            return True
        async with self._lock:
            if self._ready:
                return True
            try:
                await asyncio.to_thread(self._connect)
            except Exception as exc:  # noqa: BLE001 - memory is optional, chats are not
                self._failure = str(exc)
                logger.warning("memory: unavailable (%s)", exc)
                return False
            self._ready = True
            self._failure = None
            logger.info("memory: ready at %s", self.config.url)
            return True

    # -- embedding ---------------------------------------------------------

    def _embed(self, texts: list[str], *, as_query: bool) -> list[list[float]]:
        # e5-family models are trained with these prefixes and lose accuracy
        # without them; on other models the prefix is harmless boilerplate.
        if "e5" in self.config.embedding_model.lower():
            prefix = "query: " if as_query else "passage: "
            texts = [prefix + t for t in texts]
        return [list(map(float, v)) for v in self._embedder.embed(texts)]

    # -- writes ------------------------------------------------------------

    async def remember(
        self,
        *,
        group_name: str,
        chat_id: int | None,
        chat_title: str,
        text: str,
        kind: str = "turn",
        key: str | None = None,
    ) -> int:
        """Index one piece of context. Returns how many chunks were stored."""
        text = (text or "").strip()
        if not text or len(text) < self.config.min_chars:
            return 0
        if not await self.ensure_ready():
            return 0

        chunks = _chunk(text, self.config.chunk_chars, self.config.chunk_overlap)
        if not chunks:
            return 0

        base = key or uuid.uuid4().hex
        created_at = _now()

        def write() -> int:
            from qdrant_client import models

            vectors = self._embed(chunks, as_query=False)
            points = [
                models.PointStruct(
                    id=str(uuid.uuid5(_NAMESPACE, f"{group_name}|{base}|{i}")),
                    vector=vector,
                    payload={
                        "group_name": group_name,
                        "chat_id": chat_id,
                        "chat_title": chat_title,
                        "kind": kind,
                        "text": chunk,
                        "created_at": created_at,
                    },
                )
                for i, (chunk, vector) in enumerate(zip(chunks, vectors))
            ]
            # wait=True so a note the user just saved is findable by the search
            # they run one second later. Every write here is already off the
            # request path, so the wait costs nobody anything.
            self._client.upsert(
                collection_name=self.config.collection, points=points, wait=True
            )
            return len(points)

        try:
            return await asyncio.to_thread(write)
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory: failed to index %s for %s: %s", kind, group_name, exc)
            return 0

    async def remember_turn(
        self,
        *,
        group_name: str,
        chat_id: int,
        chat_title: str,
        prompt: str,
        answer: str,
        message_id: int | None = None,
    ) -> int:
        """Store a completed turn as one question-and-answer record.

        Prompt and answer go in together: the question is what makes the answer
        searchable later ("how did we set up X" finds the turn where X was set up),
        and splitting them would leave the answer chunks without that handle.
        """
        prompt = (prompt or "").strip()
        answer = (answer or "").strip()
        if not answer:
            return 0
        body = f"[{chat_title}]\nUser: {prompt}\n\nAssistant: {answer}" if prompt else answer
        return await self.remember(
            group_name=group_name,
            chat_id=chat_id,
            chat_title=chat_title,
            text=body,
            kind="turn",
            key=f"turn:{chat_id}:{message_id}" if message_id else None,
        )

    # -- reads -------------------------------------------------------------

    async def search(
        self,
        *,
        group_name: str,
        query: str,
        limit: int | None = None,
        exclude_chat_id: int | None = None,
        kind: str | None = None,
    ) -> list[MemoryHit]:
        query = (query or "").strip()
        if not query or not await self.ensure_ready():
            return []
        limit = limit or self.config.search_limit

        def read() -> list[MemoryHit]:
            from qdrant_client import models

            must: list = [
                models.FieldCondition(
                    key="group_name", match=models.MatchValue(value=group_name)
                )
            ]
            if kind:
                must.append(
                    models.FieldCondition(key="kind", match=models.MatchValue(value=kind))
                )
            must_not: list = []
            if exclude_chat_id is not None:
                must_not.append(
                    models.FieldCondition(
                        key="chat_id", match=models.MatchValue(value=exclude_chat_id)
                    )
                )

            vector = self._embed([query], as_query=True)[0]
            response = self._client.query_points(
                collection_name=self.config.collection,
                query=vector,
                query_filter=models.Filter(must=must, must_not=must_not or None),
                limit=limit,
                score_threshold=self.config.min_score,
                with_payload=True,
            )
            hits = []
            for point in response.points:
                payload = point.payload or {}
                hits.append(
                    MemoryHit(
                        text=payload.get("text", ""),
                        score=float(point.score),
                        kind=payload.get("kind", "turn"),
                        chat_id=payload.get("chat_id"),
                        chat_title=payload.get("chat_title", ""),
                        created_at=payload.get("created_at", ""),
                    )
                )
            return hits

        try:
            return await asyncio.to_thread(read)
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory: search failed for %s: %s", group_name, exc)
            return []

    # -- housekeeping ------------------------------------------------------

    async def forget_chat(self, chat_id: int) -> None:
        """Drop a deleted chat's memory, so it can't resurface in later searches."""
        if not await self.ensure_ready():
            return

        def delete() -> None:
            from qdrant_client import models

            self._client.delete(
                collection_name=self.config.collection,
                points_selector=models.FilterSelector(
                    filter=models.Filter(
                        must=[
                            models.FieldCondition(
                                key="chat_id", match=models.MatchValue(value=chat_id)
                            )
                        ]
                    )
                ),
                wait=False,
            )

        try:
            await asyncio.to_thread(delete)
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory: failed to forget chat %d: %s", chat_id, exc)

    async def count(self, group_name: str | None = None) -> int:
        if not await self.ensure_ready():
            return 0

        def do_count() -> int:
            from qdrant_client import models

            flt = None
            if group_name:
                flt = models.Filter(
                    must=[
                        models.FieldCondition(
                            key="group_name", match=models.MatchValue(value=group_name)
                        )
                    ]
                )
            return self._client.count(
                collection_name=self.config.collection, count_filter=flt, exact=True
            ).count

        try:
            return await asyncio.to_thread(do_count)
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory: count failed: %s", exc)
            return 0


# The single instance the rest of the app talks to. Configured at startup.
store: MemoryStore = MemoryStore(MemoryConfig(enabled=False))


def configure(config: MemoryConfig) -> MemoryStore:
    global store
    store = MemoryStore(config)
    return store
