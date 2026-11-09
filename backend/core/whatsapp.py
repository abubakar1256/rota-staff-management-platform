import hashlib
import json
import re
from collections import Counter
from datetime import date, time, timedelta
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


def shift_time_range(shift, separator=" – "):
    end = shift["end"] + (" (next day)" if shift["overnight"] else "")
    return f"{shift['start']}{separator}{end}"


def shift_line(shift):
    day = date.fromisoformat(shift["date"])
    return f"{day:%a %d %b} | {shift_time_range(shift, '–')} | {shift['site']}"


def shift_minutes(shift):
    start = time.fromisoformat(shift["start"])
    end = time.fromisoformat(shift["end"])
    minutes = (end.hour - start.hour) * 60 + end.minute - start.minute
    return minutes + (24 * 60 if shift["overnight"] else 0)


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
    week_end = week_start + timedelta(days=6)
    updated = previous_shifts is not None
    intro = "Please find your updated weekly rota below." if updated else "Please find your weekly rota below."
    lines = [f"Hi {employee_name},", "", intro, "", f"Week: {week_start:%d/%m/%Y} – {week_end:%d/%m/%Y}"]
    if updated:
        changes = shift_changes(previous_shifts, shifts)
        if changes:
            lines.extend(["", "What changed:", *changes])
        lines.extend(["", "Please use this rota in place of the previous message."])
    for shift in shifts:
        day = date.fromisoformat(shift["date"])
        lines.extend(["", f"{day:%A}: {shift_time_range(shift)}", f"Site: {shift['site']}"])
    if not shifts:
        lines.extend(["", "You have no assigned shifts for this week."])
    total_hours = f"{sum(map(shift_minutes, shifts)) / 60:.2f}".rstrip("0").rstrip(".")
    lines.extend([
        "", f"Total Shifts: {len(shifts)}", f"Total Hours: {total_hours}",
        "", "Please confirm receipt of your rota.", "", "Kind regards,", "Control Room",
    ])
    return "\n".join(lines)
