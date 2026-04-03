#!/usr/bin/env python3
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
import os

def create_605_hp_spec():
    doc = SimpleDocTemplate('ENG-605-MAX-Technical-Specification.pdf', pagesize=letter,
                            leftMargin=0.75*inch, rightMargin=0.75*inch,
                            topMargin=0.75*inch, bottomMargin=0.75*inch)

    title = ParagraphStyle('Title', fontSize=20, spaceAfter=8, alignment=TA_CENTER, 
                           textColor=colors.Color(0.12, 0.15, 0.25), fontName='Helvetica-Bold')
    subtitle = ParagraphStyle('Subtitle', fontSize=11, spaceAfter=20, alignment=TA_CENTER,
                              textColor=colors.Color(0.4, 0.4, 0.4), fontName='Helvetica-Oblique')
    section = ParagraphStyle('Section', fontSize=12, spaceBefore=18, spaceAfter=10,
                             textColor=colors.Color(0.12, 0.15, 0.25), fontName='Helvetica-Bold')
    body = ParagraphStyle('Body', fontSize=10, spaceBefore=4, spaceAfter=8,
                          textColor=colors.Color(0.15, 0.15, 0.15), alignment=TA_JUSTIFY, leading=14)
    spec = ParagraphStyle('Spec', fontSize=10, spaceBefore=4, spaceAfter=4,
                          textColor=colors.Color(0.2, 0.2, 0.2), leftIndent=20, leading=14)
    note = ParagraphStyle('Note', fontSize=9, spaceBefore=10, spaceAfter=10,
                          textColor=colors.Color(0.15, 0.4, 0.15), fontName='Helvetica-Oblique',
                          borderPadding=10, backColor=colors.Color(0.94, 0.98, 0.94))
    warn = ParagraphStyle('Warn', fontSize=9, spaceBefore=12, spaceAfter=10,
                          textColor=colors.Color(0.6, 0.1, 0.1), fontName='Helvetica-Bold',
                          borderPadding=10, backColor=colors.Color(1, 0.94, 0.94))

    story = []
    story.append(Paragraph('Component Compatibility Requirements', title))
    story.append(Paragraph('605 HP Maximum Performance Engine', subtitle))

    story.append(Paragraph('1. PURPOSE AND SCOPE', section))
    story.append(Paragraph(
        'This document establishes mandatory component compatibility requirements for the '
        '<b>605 HP Maximum Performance Engine</b>. All configurations using this engine must include '
        'supporting components that meet or exceed the specifications defined herein.',
        body))
    story.append(Paragraph(
        'The 605 HP engine is the highest output powerplant in the Titan Trucks lineup. Its exceptional '
        'power places significant demands on turbocharger, cooling, and drivetrain systems that exceed '
        'standard component capabilities.',
        body))

    story.append(Paragraph('2. ENGINE CHARACTERISTICS', section))
    data = [['Characteristic', 'Value', 'Compatibility Impact'],
            ['Peak Power', '605 HP @ 1,800 RPM', 'Determines turbo boost requirement'],
            ['Peak Torque', '2,050 lb-ft @ 1,200 RPM', 'Determines transmission rating'],
            ['Thermal Load', '~420 kW rejected', 'Determines cooling capacity']]
    t = Table(data, colWidths=[1.5*inch, 1.7*inch, 2.6*inch])
    t.setStyle(TableStyle([
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('BACKGROUND', (0,0), (-1,0), colors.Color(0.12, 0.15, 0.25)),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('GRID', (0,0), (-1,-1), 0.5, colors.Color(0.7, 0.7, 0.75)),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t)

    story.append(Paragraph('3. TURBOCHARGER SYSTEM REQUIREMENTS', section))
    story.append(Paragraph(
        'The 605 HP engine requires forced induction capable of sustaining high boost pressure under '
        'continuous heavy load.',
        body))
    story.append(Paragraph('<b>Boost Pressure:</b> Minimum <b>40 PSI sustained boost</b> at rated engine speed. '
        'This ensures adequate air mass flow for complete combustion.', spec))
    story.append(Paragraph('<b>Power Support Rating:</b> Minimum <b>605 HP continuous duty</b> rating. '
        'Lower-rated units may experience bearing wear or compressor surge.', spec))
    story.append(Paragraph(
        'Single fixed-geometry turbochargers and standard variable geometry units typically cannot achieve these '
        'specifications. Compound turbo or high-capacity twin VGT systems are generally required.',
        note))

    story.append(Paragraph('4. COOLING SYSTEM REQUIREMENTS', section))
    story.append(Paragraph(
        'At maximum output, the 605 HP engine generates approximately 420 kW of thermal energy. Inadequate cooling '
        'results in elevated temperatures and potential engine damage.',
        body))
    story.append(Paragraph('<b>Thermal Capacity:</b> Minimum <b>600 HP heat rejection capacity</b>. '
        'This provides margin for ambient variation and system aging.', spec))
    story.append(Paragraph('<b>Ambient Rating:</b> Must maintain safe temperatures at ambient up to <b>115 degrees F</b>.', spec))
    story.append(Paragraph(
        'Standard radiators designed for 300-500 HP engines lack the core surface area required. '
        'Extreme-duty or heavy-duty cooling packages with enhanced cores are required.',
        note))

    story.append(PageBreak())

    story.append(Paragraph('5. TRANSMISSION REQUIREMENTS', section))
    story.append(Paragraph(
        'The 605 HP engine produces 2,050 lb-ft peak torque which must be transmitted without exceeding '
        'component stress limits.',
        body))
    story.append(Paragraph('<b>Torque Capacity:</b> Minimum <b>2,050 lb-ft continuous</b> torque rating.', spec))
    story.append(Paragraph('<b>Gear Count:</b> Minimum <b>12 forward gears</b> for optimal power band utilization.', spec))
    story.append(Paragraph(
        'Economy transmissions rated for 1,000-1,600 lb-ft will fail prematurely. Heavy-duty units with '
        'reinforced gear trains are mandatory.',
        note))

    story.append(Paragraph('6. COMPLIANCE VERIFICATION', section))
    story.append(Paragraph(
        'Configuration systems must verify turbocharger, cooling, and transmission components meet these '
        'specifications before approving builds. Verification uses component SPECS attributes in the parts catalog.',
        body))
    story.append(Paragraph(
        'CRITICAL: Non-compliant configurations shall not be approved for production. The system must identify '
        'compliant alternatives when rejecting non-compliant component selections.',
        warn))

    doc.build(story)
    print('Created: ENG-605-MAX-Technical-Specification.pdf')


def create_front_axle_spec():
    """Second PDF for manual upload demo - Front Axle compatibility requirements"""
    doc = SimpleDocTemplate('AXLE-HEAVY-DUTY-Specification.pdf', pagesize=letter,
                            leftMargin=0.75*inch, rightMargin=0.75*inch,
                            topMargin=0.75*inch, bottomMargin=0.75*inch)

    title = ParagraphStyle('Title', fontSize=20, spaceAfter=8, alignment=TA_CENTER, 
                           textColor=colors.Color(0.15, 0.25, 0.12), fontName='Helvetica-Bold')
    subtitle = ParagraphStyle('Subtitle', fontSize=11, spaceAfter=20, alignment=TA_CENTER,
                              textColor=colors.Color(0.4, 0.4, 0.4), fontName='Helvetica-Oblique')
    section = ParagraphStyle('Section', fontSize=12, spaceBefore=18, spaceAfter=10,
                             textColor=colors.Color(0.15, 0.25, 0.12), fontName='Helvetica-Bold')
    body = ParagraphStyle('Body', fontSize=10, spaceBefore=4, spaceAfter=8,
                          textColor=colors.Color(0.15, 0.15, 0.15), alignment=TA_JUSTIFY, leading=14)
    spec = ParagraphStyle('Spec', fontSize=10, spaceBefore=4, spaceAfter=4,
                          textColor=colors.Color(0.2, 0.2, 0.2), leftIndent=20, leading=14)
    note = ParagraphStyle('Note', fontSize=9, spaceBefore=10, spaceAfter=10,
                          textColor=colors.Color(0.15, 0.35, 0.2), fontName='Helvetica-Oblique',
                          borderPadding=10, backColor=colors.Color(0.94, 0.98, 0.94))
    warn = ParagraphStyle('Warn', fontSize=9, spaceBefore=12, spaceAfter=10,
                          textColor=colors.Color(0.6, 0.1, 0.1), fontName='Helvetica-Bold',
                          borderPadding=10, backColor=colors.Color(1, 0.94, 0.94))

    story = []
    story.append(Paragraph('Component Compatibility Requirements', title))
    story.append(Paragraph('20,000 lb Heavy-Duty Front Axle', subtitle))

    story.append(Paragraph('1. PURPOSE AND SCOPE', section))
    story.append(Paragraph(
        'This document establishes mandatory component compatibility requirements for the '
        '<b>20,000 lb Heavy-Duty Front Axle</b>. All configurations using this axle must include '
        'braking, steering, and suspension components rated for the increased load capacity.',
        body))
    story.append(Paragraph(
        'The 20,000 lb front axle is designed for maximum payload applications where standard '
        '12,000-14,000 lb axles are insufficient. This increased capacity requires corresponding '
        'upgrades to related chassis systems.',
        body))

    story.append(Paragraph('2. AXLE CHARACTERISTICS', section))
    data = [['Characteristic', 'Value', 'Compatibility Impact'],
            ['Gross Axle Weight Rating', '20,000 lb', 'Determines brake capacity'],
            ['Kingpin Size', '2.5 inch', 'Determines steering component sizing'],
            ['Beam Thickness', '4.5 inch', 'Determines suspension mount requirements']]
    t = Table(data, colWidths=[1.7*inch, 1.5*inch, 2.6*inch])
    t.setStyle(TableStyle([
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('BACKGROUND', (0,0), (-1,0), colors.Color(0.15, 0.25, 0.12)),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('GRID', (0,0), (-1,-1), 0.5, colors.Color(0.7, 0.7, 0.75)),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t)

    story.append(Paragraph('3. BRAKE SYSTEM REQUIREMENTS', section))
    story.append(Paragraph(
        'The 20,000 lb axle requires braking systems capable of handling the increased kinetic energy '
        'during deceleration events.',
        body))
    story.append(Paragraph('<b>Brake Drum Diameter:</b> Minimum <b>16.5 inches</b> to provide adequate '
        'swept area for heat dissipation.', spec))
    story.append(Paragraph('<b>Brake Shoe Width:</b> Minimum <b>7 inches</b> to distribute braking '
        'force across sufficient friction material.', spec))
    story.append(Paragraph('<b>Stopping Capacity:</b> System must be rated for minimum <b>20,000 lb GAWR</b>.', spec))
    story.append(Paragraph(
        'Standard brake packages designed for 12,000-14,000 lb axles will experience accelerated wear, '
        'brake fade, and potential failure under heavy braking. Extended-service or heavy-duty brake '
        'packages are required.',
        note))

    story.append(Paragraph('4. STEERING SYSTEM REQUIREMENTS', section))
    story.append(Paragraph(
        'Increased axle weight requires steering components with greater load-bearing capacity '
        'and durability.',
        body))
    story.append(Paragraph('<b>Steering Gear Rating:</b> Minimum <b>20,000 lb</b> axle capacity rating.', spec))
    story.append(Paragraph('<b>Tie Rod Diameter:</b> Minimum <b>1.5 inches</b> for adequate strength under load.', spec))
    story.append(Paragraph(
        'Standard steering components may experience premature wear or failure. Heavy-duty steering '
        'gear and linkage are required for reliable operation.',
        note))

    story.append(PageBreak())

    story.append(Paragraph('5. SUSPENSION REQUIREMENTS', section))
    story.append(Paragraph(
        'The front suspension must be rated to support the increased axle capacity while maintaining '
        'acceptable ride quality and handling.',
        body))
    story.append(Paragraph('<b>Spring Rating:</b> Minimum <b>20,000 lb</b> combined capacity.', spec))
    story.append(Paragraph('<b>Shock Absorber Rating:</b> Heavy-duty units rated for <b>Class 8</b> applications.', spec))
    story.append(Paragraph(
        'Standard suspension packages will bottom out under load and experience accelerated wear. '
        'Heavy-duty or vocational suspension packages are required.',
        note))

    story.append(Paragraph('6. COMPLIANCE VERIFICATION', section))
    story.append(Paragraph(
        'Configuration systems must verify brake, steering, and suspension components meet these '
        'specifications when the 20,000 lb front axle is selected. Verification uses component '
        'SPECS attributes in the parts catalog.',
        body))
    story.append(Paragraph(
        'CRITICAL: Non-compliant configurations pose safety risks and shall not be approved. '
        'Undersized brakes or steering components on heavy-duty axles may result in loss of vehicle control.',
        warn))

    doc.build(story)
    print('Created: AXLE-HEAVY-DUTY-Specification.pdf')


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    create_605_hp_spec()
    create_front_axle_spec()
