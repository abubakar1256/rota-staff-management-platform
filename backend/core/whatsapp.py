import hashlib
import json
import re
from collections import Counter
from datetime import date, timedelta
from urllib.parse import quote


def normalise_whatsapp_number(value):
    compact = re.sub(r"[\s()-]", "", value)
    if compact.startswith("00"):
        compact = "+" + compact[2:]
    if not re.fullmatch(r"\+[1-9][0-9]{7,14}", compact):
        raise ValueError("Enter a WhatsApp number with its country code, such as +44 followed by the national number.")
    return compact


def whatsapp_link(number, message):
    return f"https://wa.me/{number[1:]}?text={quote(message, safe='')}"


def message_version(*values):
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def shift_snapshot(assignment):
    start = assignment.scheduled_start or assignment.shift_type.start_time
    end = assignment.scheduled_end or assignment.shift_type.end_time
    return {
        "id": assignment.pk,
        "date": assignment.work_date.isoformat(),
        "start": start.strftime("%H:%M"),
        "end": end.strftime("%H:%M"),
        "overnight": end <= start,
        "site": assignment.site.name,
    }


def shift_key(shift):
    return (shift["date"], shift["start"], shift["end"], shift["overnight"], shift["site"])


def shift_line(shift):
    day = date.fromisoformat(shift["date"])
    end = shift["end"] + (" (next day)" if shift["overnight"] else "")
    return f"{day:%a %d %b} | {shift['start']}–{end} | {shift['site']}"


def unmatched_shifts(source, other):
    counts = Counter(map(shift_key, other))
    for shift in source:
        key = shift_key(shift)
        if counts[key]:
            counts[key] -= 1
        else:
            yield shift


def shift_changes(previous, current):
    added = {shift["id"]: shift for shift in unmatched_shifts(current, previous)}
    changes = []
    for shift in unmatched_shifts(previous, current):
        replacement = added.pop(shift["id"], None)
        if replacement:
            changes.append(f"Changed: {shift_line(shift)} → {shift_line(replacement)}")
        else:
            changes.append(f"Cancelled: {shift_line(shift)}")
    changes.extend(f"Added: {shift_line(shift)}" for shift in added.values())
    return changes


def rota_message(week_start, employee_name, shifts, previous_shifts=None):
    heading = "Updated rota" if previous_shifts is not None else "Weekly rota"
    week_end = week_start + timedelta(days=6)
    lines = [f"*{heading} | {week_start:%d %b %Y} – {week_end:%d %b %Y}*", f"Hi {employee_name},"]
    if previous_shifts is not None:
        changes = shift_changes(previous_shifts, shifts)
        if changes:
            lines.extend(["", "*What changed*", *changes])
        lines.extend(["", "Please use this rota in place of the previous message."])
    lines.extend(["", "*Your latest shifts*"])
    if shifts:
        lines.extend(map(shift_line, shifts))
    else:
        lines.append("You have no assigned shifts for this week.")
    return "\n".join(lines)
