import hashlib
import json
import os
import re
from collections import Counter
from datetime import date, time
from urllib.parse import quote, urlencode


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
        "shift_name": assignment.shift_type.name,
    }


def shift_key(shift, *, include_name=True):
    key = (shift["date"], shift["start"], shift["end"], shift["overnight"], shift["site"])
    return (*key, shift["shift_name"]) if include_name else key


def shift_time_range(shift, separator=" – "):
    end = shift["end"] + (" (next day)" if shift["overnight"] else "")
    return f"{shift['start']}{separator}{end}"


def shift_line(shift):
    day = date.fromisoformat(shift["date"])
    name = f" ({shift['shift_name']})" if shift.get("shift_name") else ""
    return f"{day:%a %d %b} | {shift_time_range(shift, '–')} | {shift['site']}{name}"


def shift_minutes(shift):
    start = time.fromisoformat(shift["start"])
    end = time.fromisoformat(shift["end"])
    minutes = (end.hour - start.hour) * 60 + end.minute - start.minute
    return minutes + (24 * 60 if shift["overnight"] else 0)


def unmatched_shifts(source, other, *, include_name):
    counts = Counter(shift_key(shift, include_name=include_name) for shift in other)
    for shift in source:
        key = shift_key(shift, include_name=include_name)
        if counts[key]:
            counts[key] -= 1
        else:
            yield shift


def shift_changes(previous, current):
    include_name = all("shift_name" in shift for shift in previous)
    added = {shift["id"]: shift for shift in unmatched_shifts(current, previous, include_name=include_name)}
    changes = []
    for shift in unmatched_shifts(previous, current, include_name=include_name):
        replacement = added.pop(shift["id"], None)
        if replacement:
            changes.append(f"Changed: {shift_line(shift)} → {shift_line(replacement)}")
        else:
            changes.append(f"Cancelled: {shift_line(shift)}")
    changes.extend(f"Added: {shift_line(shift)}" for shift in added.values())
    return changes


def rota_message(week_start, employee_name, shifts, previous_shifts=None):
    updated = previous_shifts is not None
    title = "Updated Rota for the Week" if updated else "Rota for the Week"
    day = week_start.day
    suffix = "th" if 11 <= day <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    lines = [f"Hi {employee_name},", "", f"*{title}*", f"*Week Commencing: {day}{suffix} {week_start:%B %Y}*"]
    if updated:
        changes = shift_changes(previous_shifts, shifts)
        if changes:
            lines.extend(["", "What changed:", *changes])
        lines.extend(["", "Please use this rota in place of the previous message."])

    days_by_shift = {}
    for shift in shifts:
        key = (shift["site"], shift["start"], shift["end"], shift["shift_name"], shift["overnight"])
        weekday = date.fromisoformat(shift["date"]).strftime("%A")
        days_by_shift.setdefault(key, []).append(weekday)
    for (site, start, end, name, overnight), weekdays in days_by_shift.items():
        hours = f"{start.replace(':', '')}-{end.replace(':', '')} {name}"
        if overnight:
            hours += " (next day)"
        lines.extend(["", f"*Site:* {site}", f"*Shift Hour:* {hours}", f"*Days:* {', '.join(weekdays)}"])
    if not shifts:
        lines.extend(["", "You have no assigned shifts for this week."])
    total_hours = f"{sum(map(shift_minutes, shifts)) / 60:.2f}".rstrip("0").rstrip(".")
    lines.extend(["", f"Total Shifts: {len(shifts)}", f"Total Hours: {total_hours}"])
    if shifts:
        lines.extend(["", "Please open the Guard Portal and select *Confirm rota*."])
        frontend_url = os.getenv("FRONTEND_URL", "").strip().rstrip("/")
        if frontend_url:
            query = urlencode({"page": "rota", "week_start": week_start.isoformat()})
            lines.append(f"{frontend_url}/guard?{query}")
    lines.extend(["", "Thank you.", "Control Room"])
    return "\n".join(lines)
