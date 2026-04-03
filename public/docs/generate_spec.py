from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, black, white
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.graphics.shapes import Drawing, Rect, Line
from reportlab.graphics import renderPDF

doc_path = "/Users/jdrew/coco_projects/BOM/truck-configurator/public/docs/ENG-605-MAX-Technical-Specification.pdf"

doc = SimpleDocTemplate(
    doc_path,
    pagesize=letter,
    rightMargin=0.75*inch,
    leftMargin=0.75*inch,
    topMargin=0.75*inch,
    bottomMargin=0.75*inch
)

styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    'CustomTitle',
    parent=styles['Heading1'],
    fontSize=24,
    spaceAfter=6,
    textColor=HexColor('#1a365d'),
    alignment=TA_CENTER,
    fontName='Helvetica-Bold'
)

subtitle_style = ParagraphStyle(
    'Subtitle',
    parent=styles['Normal'],
    fontSize=14,
    spaceAfter=20,
    textColor=HexColor('#4a5568'),
    alignment=TA_CENTER,
    fontName='Helvetica'
)

section_style = ParagraphStyle(
    'Section',
    parent=styles['Heading2'],
    fontSize=14,
    spaceBefore=16,
    spaceAfter=8,
    textColor=HexColor('#2d3748'),
    fontName='Helvetica-Bold',
    borderColor=HexColor('#e53e3e'),
    borderWidth=0,
    borderPadding=0,
)

body_style = ParagraphStyle(
    'CustomBody',
    parent=styles['Normal'],
    fontSize=10,
    spaceAfter=8,
    leading=14,
    alignment=TA_JUSTIFY,
    fontName='Helvetica'
)

warning_style = ParagraphStyle(
    'Warning',
    parent=styles['Normal'],
    fontSize=10,
    spaceAfter=8,
    leading=14,
    textColor=HexColor('#c53030'),
    fontName='Helvetica-Bold'
)

spec_label_style = ParagraphStyle(
    'SpecLabel',
    parent=styles['Normal'],
    fontSize=9,
    textColor=HexColor('#718096'),
    fontName='Helvetica'
)

spec_value_style = ParagraphStyle(
    'SpecValue',
    parent=styles['Normal'],
    fontSize=11,
    textColor=HexColor('#1a202c'),
    fontName='Helvetica-Bold'
)

story = []

story.append(Spacer(1, 0.3*inch))

story.append(Paragraph("TECHNICAL SPECIFICATION", title_style))
story.append(Paragraph("605 HP Maximum Performance Engine", subtitle_style))

header_data = [
    ["Document ID:", "ENG-605-MAX-SPEC-001", "Revision:", "2.1"],
    ["Part Number:", "ENG-605-MAX", "Classification:", "ENGINEERING"],
    ["Effective Date:", "2026-01-15", "Status:", "ACTIVE"]
]
header_table = Table(header_data, colWidths=[1.2*inch, 2.3*inch, 1.2*inch, 2*inch])
header_table.setStyle(TableStyle([
    ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
    ('FONTNAME', (2, 0), (2, -1), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
    ('TEXTCOLOR', (0, 0), (0, -1), HexColor('#4a5568')),
    ('TEXTCOLOR', (2, 0), (2, -1), HexColor('#4a5568')),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('BACKGROUND', (0, 0), (-1, -1), HexColor('#f7fafc')),
    ('BOX', (0, 0), (-1, -1), 1, HexColor('#e2e8f0')),
    ('LINEBELOW', (0, 0), (-1, -2), 0.5, HexColor('#e2e8f0')),
]))
story.append(header_table)
story.append(Spacer(1, 0.3*inch))

story.append(Paragraph("1. ENGINE SPECIFICATIONS", section_style))

engine_specs = [
    ["Parameter", "Value", "Unit"],
    ["Horsepower Rating", "605", "HP"],
    ["Peak Torque", "2,050", "lb-ft"],
    ["Displacement", "15.0", "Liters"],
    ["Bore x Stroke", "137 x 169", "mm"],
    ["Compression Ratio", "18.5:1", "-"],
    ["Fuel System", "High-Pressure Common Rail", "-"],
    ["Cooling Requirement", "600", "HP thermal capacity"],
]

engine_table = Table(engine_specs, colWidths=[2.5*inch, 2.5*inch, 1.5*inch])
engine_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#2d3748')),
    ('TEXTCOLOR', (0, 0), (-1, 0), white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 10),
    ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [white, HexColor('#f7fafc')]),
]))
story.append(engine_table)
story.append(Spacer(1, 0.25*inch))

story.append(Paragraph("2. MANDATORY COMPONENT REQUIREMENTS", section_style))

story.append(Paragraph(
    "The 605 HP Maximum Performance Engine requires specific supporting components to ensure safe and reliable operation. "
    "Failure to comply with these requirements will result in configuration rejection and potential warranty invalidation.",
    body_style
))
story.append(Spacer(1, 0.15*inch))

story.append(Paragraph("<b>2.1 Turbocharger System</b>", body_style))

turbo_reqs = [
    ["Requirement", "Minimum Value", "Specification Basis"],
    ["Boost Pressure", "40 PSI", "Combustion efficiency at rated HP"],
    ["HP Support Rating", "605 HP", "Continuous operation headroom"],
]
turbo_table = Table(turbo_reqs, colWidths=[2.2*inch, 2.2*inch, 2.2*inch])
turbo_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#38a169')),
    ('TEXTCOLOR', (0, 0), (-1, 0), white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
    ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#c6f6d5')),
]))
story.append(turbo_table)
story.append(Spacer(1, 0.1*inch))

turbo_compliance = [
    ["Option ID", "Component Name", "Boost PSI", "Max HP", "Status"],
    ["139", "Compound Turbo System", "40", "650", "COMPLIANT"],
    ["140", "Twin VGT System", "45", "700", "COMPLIANT"],
    ["135", "Single Fixed-Geometry Turbo", "15", "350", "NON-COMPLIANT"],
    ["136", "Variable Geometry Turbo", "25", "500", "NON-COMPLIANT"],
    ["137", "Twin-Scroll VGT", "30", "550", "NON-COMPLIANT"],
    ["138", "Electric Assist Turbo", "35", "600", "NON-COMPLIANT"],
]
turbo_comp_table = Table(turbo_compliance, colWidths=[0.8*inch, 2.2*inch, 0.9*inch, 0.9*inch, 1.3*inch])
turbo_comp_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#4a5568')),
    ('TEXTCOLOR', (0, 0), (-1, 0), white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 8),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('ALIGN', (1, 1), (1, -1), 'LEFT'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ('TOPPADDING', (0, 0), (-1, -1), 5),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
    ('BACKGROUND', (4, 1), (4, 2), HexColor('#c6f6d5')),
    ('TEXTCOLOR', (4, 1), (4, 2), HexColor('#276749')),
    ('BACKGROUND', (4, 3), (4, -1), HexColor('#fed7d7')),
    ('TEXTCOLOR', (4, 3), (4, -1), HexColor('#c53030')),
    ('FONTNAME', (4, 1), (4, -1), 'Helvetica-Bold'),
]))
story.append(turbo_comp_table)
story.append(Spacer(1, 0.2*inch))

story.append(Paragraph("<b>2.2 Cooling System</b>", body_style))

cooling_reqs = [
    ["Requirement", "Minimum Value", "Specification Basis"],
    ["Thermal Capacity", "600 HP", "Heat rejection at full load"],
    ["Max Ambient Temp", "115 F", "Operating environment rating"],
]
cooling_table = Table(cooling_reqs, colWidths=[2.2*inch, 2.2*inch, 2.2*inch])
cooling_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#3182ce')),
    ('TEXTCOLOR', (0, 0), (-1, 0), white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
    ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#bee3f8')),
]))
story.append(cooling_table)
story.append(Spacer(1, 0.1*inch))

cooling_compliance = [
    ["Option ID", "Component Name", "Cooling HP", "Max Temp", "Status"],
    ["111", "Extreme Duty Cooling", "650", "120 F", "COMPLIANT"],
    ["106", "Standard Aluminum Radiator", "300", "100 F", "NON-COMPLIANT"],
    ["107", "High-Capacity Radiator", "400", "110 F", "NON-COMPLIANT"],
    ["108", "Aluminum-Brass Radiator", "450", "110 F", "NON-COMPLIANT"],
    ["109", "Extended Core Radiator", "350", "105 F", "NON-COMPLIANT"],
    ["110", "Heavy-Duty Cooling Package", "550", "115 F", "NON-COMPLIANT"],
]
cooling_comp_table = Table(cooling_compliance, colWidths=[0.8*inch, 2.2*inch, 0.9*inch, 0.9*inch, 1.3*inch])
cooling_comp_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#4a5568')),
    ('TEXTCOLOR', (0, 0), (-1, 0), white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 8),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('ALIGN', (1, 1), (1, -1), 'LEFT'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ('TOPPADDING', (0, 0), (-1, -1), 5),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
    ('BACKGROUND', (4, 1), (4, 1), HexColor('#c6f6d5')),
    ('TEXTCOLOR', (4, 1), (4, 1), HexColor('#276749')),
    ('BACKGROUND', (4, 2), (4, -1), HexColor('#fed7d7')),
    ('TEXTCOLOR', (4, 2), (4, -1), HexColor('#c53030')),
    ('FONTNAME', (4, 1), (4, -1), 'Helvetica-Bold'),
]))
story.append(cooling_comp_table)
story.append(Spacer(1, 0.2*inch))

story.append(Paragraph("<b>2.3 Transmission Assembly</b>", body_style))

trans_reqs = [
    ["Requirement", "Minimum Value", "Specification Basis"],
    ["Torque Capacity", "2,050 lb-ft", "Peak engine torque handling"],
    ["Gear Count", "12+", "Optimal power band utilization"],
]
trans_table = Table(trans_reqs, colWidths=[2.2*inch, 2.2*inch, 2.2*inch])
trans_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#805ad5')),
    ('TEXTCOLOR', (0, 0), (-1, 0), white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
    ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e9d8fd')),
]))
story.append(trans_table)
story.append(Spacer(1, 0.1*inch))

trans_compliance = [
    ["Option ID", "Component Name", "Torque Cap", "Gears", "Status"],
    ["253", "18-Speed Automatic", "2,200", "18", "COMPLIANT"],
    ["248", "10-Speed Manual", "1,200", "10", "NON-COMPLIANT"],
    ["249", "9-Speed Economy", "1,000", "9", "NON-COMPLIANT"],
    ["250", "13-Speed Manual", "1,650", "13", "NON-COMPLIANT"],
    ["251", "10-Speed Automated", "1,400", "10", "NON-COMPLIANT"],
    ["252", "12-Speed Automated Manual", "1,850", "12", "NON-COMPLIANT"],
]
trans_comp_table = Table(trans_compliance, colWidths=[0.8*inch, 2.2*inch, 0.9*inch, 0.9*inch, 1.3*inch])
trans_comp_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#4a5568')),
    ('TEXTCOLOR', (0, 0), (-1, 0), white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 8),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('ALIGN', (1, 1), (1, -1), 'LEFT'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ('TOPPADDING', (0, 0), (-1, -1), 5),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
    ('BACKGROUND', (4, 1), (4, 1), HexColor('#c6f6d5')),
    ('TEXTCOLOR', (4, 1), (4, 1), HexColor('#276749')),
    ('BACKGROUND', (4, 2), (4, -1), HexColor('#fed7d7')),
    ('TEXTCOLOR', (4, 2), (4, -1), HexColor('#c53030')),
    ('FONTNAME', (4, 1), (4, -1), 'Helvetica-Bold'),
]))
story.append(trans_comp_table)
story.append(Spacer(1, 0.3*inch))

story.append(Paragraph("3. VALIDATION RULES", section_style))

story.append(Paragraph(
    "When Option 134 (605 HP / 2050 lb-ft Maximum Performance Engine) is selected, the configuration system must verify:",
    body_style
))

validation_rules = [
    ["Rule", "Validation Check", "Failure Action"],
    ["TURBO-001", "turbocharger.max_supported_hp >= 605", "Reject configuration"],
    ["COOL-001", "radiator.cooling_capacity_hp >= 600", "Reject configuration"],
    ["TRANS-001", "transmission.torque_capacity_lb_ft >= 2050", "Reject configuration"],
]
rules_table = Table(validation_rules, colWidths=[1.2*inch, 3.3*inch, 1.8*inch])
rules_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#e53e3e')),
    ('TEXTCOLOR', (0, 0), (-1, 0), white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTNAME', (1, 1), (1, -1), 'Courier'),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
    ('ALIGN', (0, 0), (0, -1), 'CENTER'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#feb2b2')),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [white, HexColor('#fff5f5')]),
]))
story.append(rules_table)
story.append(Spacer(1, 0.2*inch))

story.append(Paragraph(
    "<b>WARNING:</b> Configurations failing any validation rule cannot proceed to manufacturing. "
    "Non-compliant configurations must be corrected using approved component alternatives listed in this document.",
    warning_style
))

doc.build(story)
print(f"PDF created: {doc_path}")
