from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


@dataclass
class GroupConfig:
    name: str
    path: Path
    # When true, the agent runs with bypassPermissions: no Allow/Deny prompts.
    # Question cards still work. Only for projects you fully trust.
    full_access: bool = False


@dataclass
class MemoryConfig:
    """Qdrant-backed long-term memory, shared by every chat of a project."""

    enabled: bool = True
    url: str = "http://127.0.0.1:6333"
    api_key: str | None = None
    collection: str = "project_memory"
    # A fastembed model name, downloaded once on first use. This one is ~220 MB,
    # covers ~50 languages (Russian included) and runs fine on CPU;
    # `intfloat/multilingual-e5-large` retrieves better but is 2.2 GB and much
    # slower. Changing the model changes the vector size, so switch `collection`
    # at the same time.
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    # Turns shorter than this are noise ("ok", "thanks") and are not indexed.
    min_chars: int = 40
    # Long turns are split into overlapping chunks so a search hits the relevant
    # part rather than the whole wall of text. Kept well under the model's input
    # window, since anything past it is silently truncated before embedding.
    chunk_chars: int = 700
    chunk_overlap: int = 120
    # How many hits the agent's search tool returns by default.
    search_limit: int = 6
    # Hits below this cosine score are dropped as unrelated.
    min_score: float = 0.5


def config_file(config_path: str | Path | None = None) -> Path:
    return Path(config_path) if config_path else REPO_ROOT / "config.yaml"


def _load_raw(config_path: str | Path | None) -> dict:
    path = config_file(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")
    return yaml.safe_load(path.read_text()) or {}


def load_memory(config_path: str | Path | None = None) -> MemoryConfig:
    """config.yaml, then MEMORY_* env vars on top.

    The environment wins because the same config.yaml is read from the host and
    from inside a container, where `127.0.0.1:6333` points at the wrong place —
    compose sets MEMORY_URL rather than forcing a second config file.
    """
    raw = dict(_load_raw(config_path).get("memory") or {})
    defaults = MemoryConfig()

    for field in MemoryConfig.__dataclass_fields__:
        value = os.environ.get(f"MEMORY_{field.upper()}")
        if not value:
            continue
        current = getattr(defaults, field)
        # Env vars arrive as text; the numeric and boolean settings have to come
        # back as the types the store actually uses.
        if isinstance(current, bool):
            raw[field] = value.strip().lower() not in ("0", "false", "no", "off")
        elif isinstance(current, int):
            raw[field] = int(value)
        elif isinstance(current, float):
            raw[field] = float(value)
        else:
            raw[field] = value

    return MemoryConfig(**{k: v for k, v in raw.items() if k in MemoryConfig.__dataclass_fields__})


def load_groups(config_path: str | Path | None = None) -> list[GroupConfig]:
    raw = _load_raw(config_path)
    groups = []
    for g in raw.get("groups", []):
        group_path = Path(g["path"]).expanduser()
        if not group_path.is_dir():
            raise NotADirectoryError(f"Group '{g['name']}': path does not exist: {group_path}")
        groups.append(
            GroupConfig(name=g["name"], path=group_path, full_access=bool(g.get("full_access", False)))
        )

    if not groups:
        raise ValueError("No groups configured in config.yaml")

    return groups


def append_group(
    name: str,
    path: Path,
    full_access: bool = False,
    config_path: str | Path | None = None,
) -> GroupConfig:
    """Write one more group into config.yaml and hand it back.

    Edited as text rather than round-tripped through yaml.safe_dump, which would
    rewrite the whole file and throw away every comment in it — the memory block
    especially is mostly comments explaining what to change and why. The entry is
    inserted at the end of the `groups:` list, i.e. before the first line that
    starts a new top-level key.
    """
    file = config_file(config_path)
    lines = file.read_text().splitlines()

    try:
        start = next(i for i, line in enumerate(lines) if line.rstrip() == "groups:")
    except StopIteration as exc:
        raise ValueError("config.yaml has no `groups:` block to add to") from exc

    # The list ends at the first line back in column zero — the next top-level
    # key, or the comment block introducing it. Comments there belong to what
    # follows, so inserting after them would file the group under `memory:`.
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].strip() and not lines[i][0].isspace():
            end = i
            break

    # Trailing blank lines belong to whatever comes next, not to the list.
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1

    entry = [f"  - name: {name}", f"    path: {path}"]
    if full_access:
        entry.append("    full_access: true")

    updated = lines[:end] + entry + lines[end:]
    text = "\n".join(updated) + "\n"

    # Parse before writing: a malformed config takes down the next startup, and
    # the group list in memory would be the only place this ever existed.
    parsed = yaml.safe_load(text) or {}
    if not any(g.get("name") == name for g in parsed.get("groups", [])):
        raise ValueError("Writing the group did not produce a readable config.yaml")

    file.write_text(text)
    return GroupConfig(name=name, path=path, full_access=full_access)
