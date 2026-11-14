#!/usr/bin/env python3
"""Read one bounded page of Feishu Project operations for Relay."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill", type=Path, required=True)
    parser.add_argument("--parent", required=True)
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--cursor")
    args = parser.parse_args()
    if not re.fullmatch(r"[1-9]\d{9,18}", args.parent) or not 0 < args.start < args.end:
        parser.error("invalid work item or time range")
    if args.cursor and (len(args.cursor) > 256 or not re.fullmatch(r"[A-Za-z0-9_+=/-]+", args.cursor)):
        parser.error("invalid cursor")

    sys.path.insert(0, str(args.skill / "scripts"))
    import feishu_project_openapi as project  # noqa: PLC0415

    config = project.load_config(args.skill / "config" / "feishu-project-openapi.local.json")
    headers = project.get_plugin_headers(config)
    body = {"project_key": config["project_key"], "work_item_ids": [int(args.parent)],
            "page_size": 100, "start": args.start, "end": args.end}
    if args.cursor:
        body["start_from"] = args.cursor
    payload = project.request_json(f"{project.BASE_URL}/open_api/op_record/work_item/list",
                                   method="POST", headers=headers, body=body)
    data = payload.get("data") or {}
    records = data.get("op_records") or []
    if not isinstance(records, list) or not isinstance(data.get("has_more"), bool):
        raise ValueError("operation response is incomplete")
    events = []
    for row in records:
        if not isinstance(row, dict) or str(row.get("work_item_id")) != args.parent or row.get("project_key") != config["project_key"]:
            raise ValueError("operation work item identity mismatch")
        timestamp = row.get("operation_time")
        if type(timestamp) is not int or not args.start <= timestamp <= args.end:
            raise ValueError("operation time is invalid")
        contents = row.get("record_contents") or []
        if not isinstance(contents, list):
            raise ValueError("operation contents are invalid")
        for content in contents or [{}]:
            if not isinstance(content, dict):
                continue
            obj = content.get("object") or {}
            child_id = str(obj.get("object_value")) if isinstance(obj, dict) and obj.get("object_type") == "sub_task" else None
            if child_id and not re.fullmatch(r"[1-9]\d*", child_id):
                child_id = None
            prop = content.get("object_property")
            events.append({"at": timestamp, "module": row.get("op_record_module"),
                           "operation": row.get("operation_type"), "childId": child_id,
                           "property": prop if isinstance(prop, str) and len(prop) <= 80 else None})
    cursor = data.get("start_from") if data["has_more"] else None
    if data["has_more"] and (not isinstance(cursor, str) or not cursor):
        raise ValueError("operation cursor is missing")
    print(json.dumps({"events": events, "hasMore": data["has_more"], "cursor": cursor}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
