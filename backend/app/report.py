"""Work summaries for stand-ups: what got done in which projects over a few days.

Built from the chats' own stored history, so it covers exactly what went through
the orchestrator. The digest goes to a one-shot `claude` call with no tools, no
MCP servers and no project settings — it only has to read and condense.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import claude_agent_sdk as sdk

from app import db

# A turn's full answer can run to pages; the gist of what was done is almost
# always in its first part. Requests are kept longer — they say what the work was.
USER_CHARS = 1500
ASSISTANT_CHARS = 2500
# Ceiling on the whole digest, so a busy month still fits in one context window.
DIGEST_CHARS = 400_000

WEEKDAYS = ("пн", "вт", "ср", "чт", "пт", "сб", "вс")

PROMPT = """Ниже — история моих чатов с AI-агентами по рабочим проектам за период {period}.
Сделай краткую выжимку того, что было сделано, чтобы я мог рассказать об этом на встрече.

Правила:
- Отдельный раздел на каждый проект (заголовок `### <проект>`).
- Внутри проекта — по дням, от ранних к поздним: строка `**ДД.ММ (день недели)**`, под ней 1–5
  тезисов-буллетов: что сделано / решено / выяснено. Дни без работы по проекту пропускай.
- Каждый тезис — не длиннее 15 слов, без перечисления деталей через запятую и без пояснений «почему».
- Если работа тянулась несколько дней — упомяни её в день, когда был результат, а не дублируй каждый день.
- Только результаты и существенные шаги; без технических подробностей, путей к файлам и кода.
- Если работа не доведена до конца — так и пометь («в процессе», «упёрлись в …»).
- Если по проекту не было ничего содержательного — одна строка «ничего существенного».
- Пиши по-русски. Никаких вступлений и заключений — сразу разделы.

История:

{digest}
"""


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit].rstrip() + " …[обрезано]"


def _digest(rows: list[dict], tz: timezone) -> str:
    parts: list[str] = []
    group = chat = None
    for row in rows:
        if row["group_name"] != group:
            group, chat = row["group_name"], None
            parts.append(f"\n## Проект: {group}\n")
        if row["chat_id"] != chat:
            chat = row["chat_id"]
            parts.append(f"\n### Чат: {row['chat_title']}\n")
        local = datetime.fromisoformat(row["created_at"]).astimezone(tz)
        when = f"{local:%d.%m} {WEEKDAYS[local.weekday()]} {local:%H:%M}"
        if row["role"] == "user":
            parts.append(f"[{when}] Я: {_clip(row['content'], USER_CHARS)}\n")
        else:
            parts.append(f"[{when}] Агент: {_clip(row['content'], ASSISTANT_CHARS)}\n")
    digest = "".join(parts)
    if len(digest) > DIGEST_CHARS:
        digest = digest[:DIGEST_CHARS] + "\n…[история обрезана по объёму]"
    return digest


async def _ask_claude(prompt: str) -> str:
    options = sdk.ClaudeAgentOptions(
        tools=[],
        mcp_servers={},
        strict_mcp_config=True,
        setting_sources=[],
        max_turns=1,
    )
    result, text = None, []
    async for message in sdk.query(prompt=prompt, options=options):
        if isinstance(message, sdk.AssistantMessage):
            text.extend(b.text for b in message.content if isinstance(b, sdk.TextBlock))
        elif isinstance(message, sdk.ResultMessage):
            if message.is_error:
                raise RuntimeError(message.result or f"claude failed: {message.subtype}")
            result = message.result
    return (result or "".join(text)).strip()


async def build_report(groups: list[str], date_from: str, date_to: str, tz_offset_minutes: int) -> dict:
    """Summarise `groups` from the start of `date_from` to the end of `date_to`.

    Dates are the user's local calendar days (YYYY-MM-DD); `tz_offset_minutes` is
    their offset from UTC (east positive), which turns those days into the UTC
    range messages are stored in.
    """
    tz = timezone(timedelta(minutes=tz_offset_minutes))
    start = datetime.fromisoformat(date_from).replace(tzinfo=tz)
    end = datetime.fromisoformat(date_to).replace(tzinfo=tz) + timedelta(days=1)
    if end <= start:
        raise ValueError("The end date is before the start date")

    rows = await asyncio.to_thread(
        db.list_messages_between,
        groups,
        start.astimezone(timezone.utc).isoformat(),
        end.astimezone(timezone.utc).isoformat(),
    )
    if not rows:
        return {"summary": "", "messages": 0, "projects": []}

    period = date_from if date_from == date_to else f"{date_from} — {date_to}"
    summary = await _ask_claude(PROMPT.format(period=period, digest=_digest(rows, tz)))
    return {
        "summary": summary,
        "messages": len(rows),
        "projects": sorted({r["group_name"] for r in rows}),
    }
