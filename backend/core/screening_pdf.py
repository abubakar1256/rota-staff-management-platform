"""Fill the original Word form and reflow its sections to remove blank space.

The blank source template contains no employee data. Coordinates are extracted
from its actual table cells; all variable values remain escaped, selectable text.
"""
from copy import copy
from datetime import datetime
from io import BytesIO
import json
from pathlib import Path
from xml.sax.saxutils import escape

from django.utils import timezone
from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import RectangleObject
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ASSETS = Path(__file__).with_name("assets")
INK = colors.HexColor("#333333")
NAVY = colors.HexColor("#1F3350")
GRID = colors.HexColor("#B7C4D3")
FILL = colors.HexColor("#E9EFF5")


def display_date(value, month=False):
    if not value or str(value).strip().upper() == "N/A":
        return "N/A"
    try:
        if month:
            return datetime.strptime(str(value), "%Y-%m").strftime("%m/%Y")
        if isinstance(value, datetime):
            parsed = timezone.localtime(value) if timezone.is_aware(value) else value
        else:
            parsed = datetime.fromisoformat(str(value))
            if timezone.is_aware(parsed):
                parsed = timezone.localtime(parsed)
        return parsed.strftime("%d/%m/%Y")
    except (ValueError, TypeError):
        return str(value)


def joined(*values):
    return "\n".join(str(v) for v in values if v not in (None, "")) or "N/A"


def period(row):
    start = display_date(row.get("from_month"), month=True)
    end = display_date(row["to_month"], month=True) if row.get("to_month") else "Current"
    return f"{start} - {end}"


def compact_pages(pages, layout, data):
    """Move original vector table sections; retain fonts, widths and wording.

    Crop only unused repeat rows and blank margins, never populated answers.
    Keep headings with their tables and keep the signature date with signature.
    """
    def end_row(page, table, count):
        rows = layout["pages"][page]["tables"][table]["rows"]
        index = min(max(1, count), len(rows) - 1)
        return max(box[3] for box in rows[index] if box) + .5

    activity_count = len(data.get("activities", []))
    activity = [(0, 594, end_row(0, 2, min(activity_count, 4)))]
    if activity_count > 4:
        activity.append((1, 45, end_row(1, 0, activity_count - 4)))
    activity.append((1, 134, 155))
    blocks = [
        [(0, 45, 404)],
        [(0, 414, 588)],
        activity,
        [(2, 45, end_row(2, 0, len(data.get("referees", [])))), (2, 206, 227)],
        [(2, 234, end_row(2, 1, len(data.get("gaps", []))))],
        [(2, 420, end_row(2, 2, len(data.get("education", []))))],
        [(2, 568, end_row(2, 3, 3))],
        [(3, 45, 177), (4, 45, 75)],
        [(4, 88, 172)],
        [(5, 45, 411)],
    ]
    writer = PdfWriter()
    width, height = 595.32, 841.92
    cursor = 45
    target = writer.add_blank_page(width=width, height=height)
    for block in blocks:
        needed = sum(bottom - top for _, top, bottom in block)
        if cursor + needed > height - 45:
            target = writer.add_blank_page(width=width, height=height)
            cursor = 45
        for index, top, bottom in block:
            region = copy(pages[index])
            region.cropbox = RectangleObject((0, height - bottom, width, height - top))
            target.merge_transformed_page(region, Transformation().translate(ty=top - cursor))
            cursor += bottom - top
        cursor += 8
    return writer


def build_screening_pdf(case, include_office=False):
    layout = json.loads((ASSETS / "screening-layout.json").read_text(encoding="utf-8"))
    source = PdfReader(ASSETS / "security-screening-template.pdf")
    data = case.form_data
    placements = [[] for _ in source.pages]
    overflow = []

    def cell(page, table, row, column, value, label):
        box = layout["pages"][page]["tables"][table]["rows"][row][column]
        placements[page].append((box, str(value) if value not in (None, "") else "N/A", label))

    def field_rows(page, table, values):
        for index, (label, value) in enumerate(values, 1):
            cell(page, table, index, 1, value, label)

    field_rows(0, 0, [
        ("Full name", data.get("full_name")),
        ("Previous names", data.get("previous_names")),
        ("Date of birth", display_date(data.get("date_of_birth"))),
        ("National Insurance number", data.get("national_insurance_number")),
        ("Telephone", data.get("phone")), ("Email", data.get("email")),
        ("Job title", data.get("job_title")),
        ("Proposed start date", display_date(data.get("proposed_start_date"))),
    ])
    addresses = data.get("addresses", [])
    field_rows(0, 1, [("Current address", data.get("current_address")),
                     ("Moved in", display_date(data.get("moved_in"), month=True)),
                     ("Previous address", addresses[0].get("address") if addresses else "N/A"),
                     ("Previous address dates", period(addresses[0]) if addresses else "N/A")])
    if len(addresses) > 1:
        overflow.append(("Previous addresses", ["Address", "Dates lived there"],
                         [[r.get("address", "N/A"), period(r)] for r in addresses[1:]], [310, 183.3]))

    def repeated(title, rows, slots, headers, values):
        for index, (page, table, row) in enumerate(slots):
            if index < len(rows):
                for col, value in enumerate(values(rows[index])):
                    cell(page, table, row, col, value, f"{title}, entry {index + 1}, {headers[col]}")
            elif index == 0:
                cell(page, table, row, 0, "N/A", title)
        if len(rows) > len(slots):
            page, table, _ = slots[0]
            cells = layout["pages"][page]["tables"][table]["rows"][0]
            widths = [box[2] - box[0] for box in cells]
            overflow.append((title, headers, [values(r) for r in rows[len(slots):]], widths))

    repeated("Employment and activity history", data.get("activities", []),
             [(0, 2, i) for i in range(1, 5)] + [(1, 0, i) for i in range(1, 3)],
             ["From (MM/YYYY)", "To (MM/YYYY)", "Employer / activity", "Job title and brief duties", "Location", "Reason for leaving / end"],
             lambda r: [display_date(r.get("from_month"), True), display_date(r["to_month"], True) if r.get("to_month") else "Current", r.get("organisation"), r.get("duties"), r.get("location"), r.get("reason_ended")])
    repeated("Employer / referee contact details", data.get("referees", []), [(2, 0, i) for i in range(1, 5)],
             ["Employer / referee", "Name and job title", "Telephone / email", "Dates they can verify"],
             lambda r: [joined(r.get("employer"), r.get("notes")), joined(r.get("name"), r.get("job_title")), joined(r.get("phone"), r.get("email")), period(r)])
    repeated("Gaps or periods not covered above", data.get("gaps", []), [(2, 1, i) for i in range(1, 5)],
             ["Dates (from / to)", "Reason for the period", "Supporting details / contact (if available)"],
             lambda r: [period(r), r.get("reason"), r.get("evidence")])
    repeated("Education, training and qualifications", data.get("education", []), [(2, 2, i) for i in range(1, 4)],
             ["School / college / provider", "Qualification or course", "Dates attended", "Contact / evidence (if available)"],
             lambda r: [r.get("provider"), r.get("course"), period(r), r.get("evidence")])
    field_rows(2, 3, [("SIA licence held", data.get("sia_held")),
                     ("SIA licence type and number", joined(data.get("sia_type"), data.get("sia_number"))),
                     ("Employment / activity history explanation", data.get("history_notes"))])
    cell(3, 0, 0, 1, data.get("signature_name"), "Employee signature")
    cell(3, 0, 1, 1, data.get("print_name") or data.get("full_name"), "Print full name")
    cell(4, 0, 0, 1, display_date(data.get("signed_date") or case.submitted_at), "Date")

    if include_office:
        office = case.office_data

        def check(key):
            result = " - ".join(str(v) for v in (office.get(key), office.get(key + "_by")) if v)
            return joined(result,
                          display_date(office[key + "_at"]) if office.get(key + "_at") else None)

        field_rows(5, 0, [
            ("Form received by / date", joined(office.get("received_by"), display_date(office.get("received_date") or case.submitted_at))),
            ("Identity check completed / date", check("identity")),
            ("Right to work check completed / date", check("right_to_work")),
            ("Employment / activity history reviewed by / date", check("history")),
            ("Gaps requiring follow-up", office.get("gaps_follow_up")),
            ("References requested / received", office.get("reference_records")),
            ("Other checks required for this role", office.get("other_checks_required")),
            ("Outstanding actions / notes", joined(office.get("outstanding_actions"), office.get("internal_notes"))),
            ("Screening outcome / decision and authorisation", joined(case.get_status_display(), office.get("decision_authorisation"))),
            ("Screening completed by / date", joined(case.completed_by.get_username() if case.completed_by else None, display_date(case.completed_at))),
        ])

    body = ParagraphStyle("ScreeningAnswer", fontName="Helvetica", fontSize=7.5, leading=9, textColor=INK, splitLongWords=True)
    buffer = BytesIO()
    canvas = Canvas(buffer, pagesize=(595.32, 841.92), pageCompression=0)
    for page_index, entries in enumerate(placements):
        height = layout["pages"][page_index]["height"]
        for (left, top, right, bottom), text, label in entries:
            width, available_height = right - left - 10, bottom - top - 6
            para = Paragraph(escape(text).replace("\n", "<br/>"), body)
            _, required_height = para.wrap(width, available_height)
            if required_height > available_height:
                tight = ParagraphStyle("ScreeningCompactAnswer", parent=body, leading=8)
                compact = Paragraph(escape(text).replace("\n", "<br/>"), tight)
                _, compact_height = compact.wrap(width, bottom - top - 2)
                if compact_height <= bottom - top - 2:
                    para, required_height = compact, compact_height
                    available_height = bottom - top - 2
            if required_height > available_height:
                overflow.append((label, ["Details"], [[text]], [493.3]))
                para = Paragraph("See additional information", body)
                _, required_height = para.wrap(width, available_height)
            para.drawOn(canvas, left + 5, height - top - (bottom - top + required_height) / 2)
        canvas.showPage()
    canvas.save()
    overlays = PdfReader(BytesIO(buffer.getvalue()))
    writer = PdfWriter()
    for index, page in enumerate(source.pages):
        page.merge_page(overlays.pages[index])
        writer.add_page(page)

    writer = compact_pages(writer.pages, layout, data)

    if overflow:
        continuation = BytesIO()
        document = SimpleDocTemplate(continuation, pagesize=(595.32, 841.92), leftMargin=51, rightMargin=51, topMargin=45, bottomMargin=45)
        title_style = ParagraphStyle("ScreeningContinuation", parent=body, fontName="Helvetica-Bold", fontSize=12, leading=14, textColor=NAVY, spaceAfter=5)
        header_style = ParagraphStyle("ScreeningColumn", parent=body, fontName="Helvetica-Bold", textColor=NAVY)
        story = []
        for title, headers, rows, widths in overflow:
            cells = [[Paragraph(escape(str(h)), header_style) for h in headers]]
            cells += [[Paragraph(escape(str(v or "N/A")).replace("\n", "<br/>"), body) for v in row] for row in rows]
            table = Table(cells, colWidths=widths, repeatRows=1, hAlign="LEFT", splitInRow=1)
            table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .5, GRID), ("BACKGROUND", (0, 0), (-1, 0), FILL), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
            story.extend([Paragraph(escape(title), title_style), table, Spacer(1, 12)])
        document.build(story)
        for page in PdfReader(BytesIO(continuation.getvalue())).pages:
            writer.add_page(page)

    counters = BytesIO()
    c = Canvas(counters, pagesize=(595.32, 841.92), pageCompression=0)
    total = len(writer.pages)
    for index in range(total):
        c.setFillColor(colors.HexColor("#5F6F82"))
        c.setFont("Helvetica", 7)
        c.drawRightString(544.3, 27, f"Page {index + 1} of {total}")
        c.drawString(51, 27, "CONFIDENTIAL — EMPLOYEE SCREENING INFORMATION")
        c.showPage()
    c.save()
    for index, page in enumerate(PdfReader(BytesIO(counters.getvalue())).pages):
        writer.pages[index].merge_page(page)

    writer.add_metadata({"/Title": "Employee Security Screening Form", "/Subject": case.form_id})
    result = BytesIO()
    writer.write(result)
    return result.getvalue()

