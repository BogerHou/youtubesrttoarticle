from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from copy import deepcopy
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent
CONFIG_DIR = PROJECT_ROOT / "config" / "channels"
DATA_DIR = PROJECT_ROOT / "data" / "channels"
SHORTS_MAX_SECONDS = 180

DEFAULT_CHANNEL_INDEX: dict[str, Any] = {
    "channel_slug": "",
    "channel_name": "",
    "channel_url": "",
    "last_synced_at": None,
    "videos": [],
}

SENTENCE_END_PATTERN = re.compile(r'[.!?]["\')\]]*$')
MULTISPACE_PATTERN = re.compile(r"\s+")
INVALID_FILENAME_PATTERN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
MAX_CUE_DURATION_MS = 12_000


class SubtitleUnavailableError(RuntimeError):
    pass


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _yt_dlp_command() -> list[str]:
    executable = shutil.which("yt-dlp")
    if executable:
        return [executable]
    return [sys.executable, "-m", "yt_dlp"]


def load_channel_config(channel_slug: str) -> dict[str, Any]:
    path = CONFIG_DIR / f"{channel_slug}.json"
    if not path.exists():
        raise FileNotFoundError(f"频道配置不存在：{path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_all_channel_configs() -> list[dict[str, Any]]:
    configs: list[dict[str, Any]] = []
    for path in sorted(CONFIG_DIR.glob("*.json")):
        configs.append(json.loads(path.read_text(encoding="utf-8")))
    return configs


def _channel_root(channel_slug: str) -> Path:
    return DATA_DIR / channel_slug


def _channel_index_path(channel_slug: str) -> Path:
    return _channel_root(channel_slug) / "videos.json"


def _load_channel_index(channel_slug: str) -> dict[str, Any]:
    path = _channel_index_path(channel_slug)
    if not path.exists():
        return deepcopy(DEFAULT_CHANNEL_INDEX)
    return json.loads(path.read_text(encoding="utf-8"))


def _save_channel_index(channel_slug: str, payload: dict[str, Any]) -> None:
    path = _channel_index_path(channel_slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _safe_filename(value: str, max_length: int = 120) -> str:
    value = INVALID_FILENAME_PATTERN.sub("", value)
    value = re.sub(r"\s+", " ", value).strip().strip(".")
    if not value:
        value = "untitled"
    if len(value) > max_length:
        value = value[:max_length].rstrip(" .-")
    return value


def _format_publish_date(raw_value: Any) -> str:
    if raw_value is None:
        return "unknown-date"
    value = str(raw_value).strip()
    if re.fullmatch(r"\d{8}", value):
        return f"{value[:4]}-{value[4:6]}-{value[6:8]}"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value
    if value.isdigit():
        try:
            return datetime.fromtimestamp(int(value), tz=timezone.utc).date().isoformat()
        except (OverflowError, OSError, ValueError):
            return "unknown-date"
    if re.match(r"\d{4}-\d{2}-\d{2}", value):
        return value[:10]
    return "unknown-date"


def _video_url(entry: dict[str, Any], video_id: str) -> str:
    for key in ("webpage_url", "url"):
        value = entry.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
    return f"https://www.youtube.com/watch?v={video_id}"


def _subtitle_path(channel_slug: str, video: dict[str, Any]) -> Path:
    published_at = _format_publish_date(video.get("published_at"))
    title = _safe_filename(str(video.get("title") or video["video_id"]))
    filename = f"{published_at} - {title} [{video['video_id']}].srt"
    return _channel_root(channel_slug) / "srt" / filename


def _article_path(channel_slug: str, video: dict[str, Any]) -> Path:
    published_at = _format_publish_date(video.get("published_at"))
    title = _safe_filename(str(video.get("title") or video["video_id"]))
    filename = f"{published_at} - {title} [{video['video_id']}].md"
    return _channel_root(channel_slug) / "articles" / filename


def _find_existing_srt(channel_slug: str, video_id: str) -> Path | None:
    srt_dir = _channel_root(channel_slug) / "srt"
    if not srt_dir.exists():
        return None
    suffix = f"[{video_id}].srt"
    matches = sorted(path for path in srt_dir.glob("*.srt") if path.name.endswith(suffix))
    return matches[0] if matches else None


def fetch_channel_entries(channel_url: str, limit: int | None = None) -> list[dict[str, Any]]:
    command = [
        *_yt_dlp_command(),
        "--flat-playlist",
        "--dump-single-json",
    ]
    if limit is not None and limit > 0:
        command.extend(["--playlist-end", str(limit)])
    command.append(channel_url)
    result = _run(command)
    payload = json.loads(result.stdout)
    entries = payload.get("entries", [])
    return entries if isinstance(entries, list) else []


def is_missing_subtitle_error(message: str) -> bool:
    lowered = message.lower()
    return "no subtitles" in lowered or "no automatic captions" in lowered


def _build_download_command(
    video_url: str,
    stem: Path,
    sub_langs: str,
    *,
    include_auto: bool,
    sub_format: str,
) -> list[str]:
    command = [
        *_yt_dlp_command(),
        "--skip-download",
        "--sub-langs",
        sub_langs,
        "--sub-format",
        sub_format,
        "--output",
        f"{stem}.%(ext)s",
    ]
    command.append("--write-auto-subs" if include_auto else "--write-subs")
    command.append(video_url)
    return command


def _find_first_downloaded_candidate(stem: Path, extension: str) -> Path | None:
    candidates = sorted(stem.parent.glob(f"{stem.name}*.{extension}"))
    return candidates[0] if candidates else None


def _format_srt_timestamp(total_ms: int) -> str:
    total_ms = max(0, total_ms)
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def _normalize_caption_text(text: str) -> str:
    text = unescape(text)
    text = MULTISPACE_PATTERN.sub(" ", text).strip()
    return re.sub(r"\s+([,.!?;:])", r"\1", text)


def _append_token_text(current_text: str, token_text: str) -> str:
    token_text = unescape(token_text).replace("\n", " ")
    if not token_text:
        return current_text
    if not current_text:
        return token_text.lstrip()
    if token_text[0].isspace():
        return current_text + token_text
    if current_text[-1].isspace() or current_text[-1] in "([{/'\"":
        return current_text + token_text
    if token_text[0] in ".,!?;:)]}\"'":
        return current_text + token_text
    return current_text + " " + token_text


def _iter_json3_tokens(source: str) -> list[tuple[int, int, str]]:
    data = json.loads(source)
    tokens: list[tuple[int, int, str]] = []

    for event in data.get("events", []):
        segs = event.get("segs") or []
        event_start = int(event.get("tStartMs", 0))
        event_end = event_start + int(event.get("dDurationMs", 0))
        visible_segments: list[tuple[int, str]] = []

        for seg in segs:
            text = seg.get("utf8", "")
            if not text or text == "\n":
                continue
            start_ms = event_start + int(seg.get("tOffsetMs", 0))
            visible_segments.append((start_ms, text))

        for index, (start_ms, text) in enumerate(visible_segments):
            if index + 1 < len(visible_segments):
                end_ms = visible_segments[index + 1][0]
            else:
                end_ms = event_end
            tokens.append((start_ms, max(start_ms + 1, end_ms), text))

    return tokens


def _should_flush_caption(
    text: str,
    start_ms: int,
    end_ms: int,
    last_token_text: str,
    next_gap_ms: int,
    *,
    is_last_token: bool,
) -> bool:
    normalized = text.strip()
    if not normalized:
        return False
    if is_last_token:
        return True
    if SENTENCE_END_PATTERN.search(last_token_text.strip()):
        return True
    if end_ms - start_ms >= MAX_CUE_DURATION_MS:
        return True
    if next_gap_ms >= 1_200 and len(normalized) >= 20:
        return True
    if len(normalized) >= 84 and last_token_text.strip().endswith((",", ";", ":")):
        return True
    return False


def json3_to_srt(source: str) -> str:
    tokens = _iter_json3_tokens(source)
    if not tokens:
        return ""

    cues: list[tuple[int, int, str]] = []
    current_text = ""
    current_start_ms: int | None = None
    current_end_ms: int | None = None

    for index, (start_ms, end_ms, text) in enumerate(tokens):
        current_text = _append_token_text(current_text, text)
        if current_start_ms is None:
            current_start_ms = start_ms
        current_end_ms = end_ms if current_end_ms is None else max(current_end_ms, end_ms)

        next_start_ms = tokens[index + 1][0] if index + 1 < len(tokens) else end_ms
        next_gap_ms = max(0, next_start_ms - end_ms)
        normalized_text = _normalize_caption_text(current_text)

        if not _should_flush_caption(
            normalized_text,
            current_start_ms,
            current_end_ms,
            text,
            next_gap_ms,
            is_last_token=index == len(tokens) - 1,
        ):
            continue

        cues.append((current_start_ms, current_end_ms, normalized_text))
        current_text = ""
        current_start_ms = None
        current_end_ms = None

    for index in range(len(cues) - 1):
        start_ms, end_ms, text = cues[index]
        next_start_ms = cues[index + 1][0]
        if end_ms > next_start_ms:
            cues[index] = (start_ms, max(start_ms + 1, next_start_ms), text)

    lines: list[str] = []
    for index, (start_ms, end_ms, text) in enumerate(cues, start=1):
        lines.extend(
            [
                str(index),
                f"{_format_srt_timestamp(start_ms)} --> {_format_srt_timestamp(end_ms)}",
                text,
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def _download_to_srt(video_url: str, output_path: Path, temp_dir: Path) -> Path:
    attempts = [
        ("en", False, "srt"),
        ("en-.*", False, "srt"),
        ("en-orig", True, "json3"),
        ("en", True, "json3"),
        ("en-.*", True, "json3"),
    ]
    temp_dir.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    for index, (sub_langs, include_auto, sub_format) in enumerate(attempts, start=1):
        stem = temp_dir / f"subtitle-attempt-{index}"
        command = _build_download_command(
            video_url,
            stem,
            sub_langs,
            include_auto=include_auto,
            sub_format=sub_format,
        )
        try:
            _run(command)
        except subprocess.CalledProcessError as exc:
            combined_output = f"{exc.stdout}\n{exc.stderr}"
            if is_missing_subtitle_error(combined_output):
                continue
            raise

        source = _find_first_downloaded_candidate(stem, sub_format)
        if source is None:
            continue
        if sub_format == "json3":
            output_path.write_text(json3_to_srt(source.read_text(encoding="utf-8")), encoding="utf-8")
        else:
            source.replace(output_path)
        return output_path

    raise SubtitleUnavailableError("没有下载到英文字幕。")


def _classify_video(entry: dict[str, Any]) -> tuple[str, str | None]:
    duration = entry.get("duration") or entry.get("duration_seconds")
    is_live = bool(entry.get("is_live"))
    if isinstance(duration, (int, float)) and duration <= SHORTS_MAX_SECONDS:
        return "skipped", "shorts"
    if is_live:
        return "skipped", "live"
    return "eligible", None


def _entry_to_video(entry: dict[str, Any], prior: dict[str, Any] | None = None) -> dict[str, Any]:
    prior = prior or {}
    video_id = str(entry.get("id") or "").strip()
    status, skip_reason = _classify_video(entry)
    return {
        "video_id": video_id,
        "title": entry.get("title") or prior.get("title") or video_id,
        "video_url": _video_url(entry, video_id),
        "published_at": _format_publish_date(
            entry.get("release_date") or entry.get("upload_date") or entry.get("timestamp") or prior.get("published_at")
        ),
        "duration_seconds": entry.get("duration") or entry.get("duration_seconds") or prior.get("duration_seconds"),
        "status": prior.get("status", status),
        "skip_reason": prior.get("skip_reason", skip_reason),
        "srt_path": prior.get("srt_path"),
        "article_path": prior.get("article_path"),
        "last_attempt_at": prior.get("last_attempt_at"),
        "failure_message": prior.get("failure_message"),
    }


def sync_channel(channel_slug: str, limit: int | None = None, *, download_srt: bool = True) -> dict[str, Any]:
    config = load_channel_config(channel_slug)
    channel_slug = config["channel_slug"]
    if limit is None:
        limit = int(config.get("max_videos") or 5)

    current = _load_channel_index(channel_slug)
    existing_by_id = {item["video_id"]: item for item in current.get("videos", []) if item.get("video_id")}
    entries = fetch_channel_entries(config["channel_url"], limit=limit)

    merged_by_id = dict(existing_by_id)
    fetched_ids: list[str] = []
    for entry in entries:
        video_id = str(entry.get("id") or "").strip()
        if not video_id:
            continue
        fetched_ids.append(video_id)
        merged_by_id[video_id] = _entry_to_video(entry, existing_by_id.get(video_id))

    for video_id in existing_by_id:
        if video_id not in fetched_ids:
            merged_by_id[video_id] = existing_by_id[video_id]

    stats = {
        "found": len(entries),
        "downloaded": 0,
        "already_exists": 0,
        "skipped": 0,
        "failed": 0,
    }

    for video_id in fetched_ids:
        video = merged_by_id[video_id]
        if video.get("skip_reason") in {"shorts", "live"}:
            stats["skipped"] += 1
            continue

        output_path = _subtitle_path(channel_slug, video)
        article_path = _article_path(channel_slug, video)
        existing_srt = Path(video["srt_path"]) if video.get("srt_path") else None
        if existing_srt is None or not existing_srt.exists():
            existing_srt = _find_existing_srt(channel_slug, video_id)
        if existing_srt and existing_srt.exists():
            video["status"] = "subtitle_downloaded"
            video["srt_path"] = str(existing_srt)
            video["article_path"] = str(article_path)
            stats["already_exists"] += 1
            continue

        video["srt_path"] = str(output_path)
        video["article_path"] = str(article_path)
        if not download_srt:
            continue

        video["last_attempt_at"] = datetime.now().astimezone().isoformat()
        temp_dir = _channel_root(channel_slug) / "_download_tmp" / video_id
        try:
            _download_to_srt(video["video_url"], output_path, temp_dir)
        except SubtitleUnavailableError as exc:
            video["status"] = "skipped"
            video["skip_reason"] = "no_english_subtitles"
            video["failure_message"] = str(exc)
            stats["skipped"] += 1
            continue
        except Exception as exc:
            video["status"] = "failed"
            video["failure_message"] = str(exc)
            stats["failed"] += 1
            continue
        finally:
            if temp_dir.exists():
                shutil.rmtree(temp_dir)

        video["status"] = "subtitle_downloaded"
        video["failure_message"] = None
        stats["downloaded"] += 1

    def sort_key(item: dict[str, Any]) -> tuple[str, str]:
        return (str(item.get("published_at") or "0000-00-00"), str(item.get("title") or ""))

    videos = sorted(merged_by_id.values(), key=sort_key)
    payload = {
        "channel_slug": channel_slug,
        "channel_name": config["channel_name"],
        "channel_url": config["channel_url"],
        "last_synced_at": datetime.now().astimezone().isoformat(),
        "videos": videos,
        "stats": stats,
    }
    _save_channel_index(channel_slug, payload)
    return payload


def print_channels() -> None:
    for config in load_all_channel_configs():
        print(f"{config['channel_slug']}\t{config['channel_name']}\t{config['channel_url']}")


def print_sync_result(payload: dict[str, Any]) -> None:
    stats = payload.get("stats", {})
    print(
        f"{payload['channel_slug']} 同步完成："
        f"found={stats.get('found', 0)} "
        f"downloaded={stats.get('downloaded', 0)} "
        f"already_exists={stats.get('already_exists', 0)} "
        f"skipped={stats.get('skipped', 0)} "
        f"failed={stats.get('failed', 0)}"
    )
    print(f"SRT目录：{_channel_root(payload['channel_slug']) / 'srt'}")
    print(f"文章目录：{_channel_root(payload['channel_slug']) / 'articles'}")


def sync_all_channels(args: argparse.Namespace) -> None:
    for config in load_all_channel_configs():
        payload = sync_channel(
            config["channel_slug"],
            args.limit,
            download_srt=not args.no_download,
        )
        print_sync_result(payload)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="同步 YouTube 频道最新视频的英文 SRT。")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list-channels", help="列出已配置频道。")
    list_parser.set_defaults(func=lambda args: print_channels())

    sync_parser = subparsers.add_parser("sync", help="同步单个频道并增量下载英文 SRT。")
    sync_parser.add_argument("channel_slug")
    sync_parser.add_argument("--limit", type=int, default=None, help="只检查频道最新 N 个视频。")
    sync_parser.add_argument("--no-download", action="store_true", help="只更新索引，不下载字幕。")
    sync_parser.set_defaults(
        func=lambda args: print_sync_result(
            sync_channel(args.channel_slug, args.limit, download_srt=not args.no_download)
        )
    )

    all_parser = subparsers.add_parser("sync-all", help="同步所有已配置频道。")
    all_parser.add_argument("--limit", type=int, default=None, help="每个频道只检查最新 N 个视频。")
    all_parser.add_argument("--no-download", action="store_true", help="只更新索引，不下载字幕。")
    all_parser.set_defaults(func=sync_all_channels)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
