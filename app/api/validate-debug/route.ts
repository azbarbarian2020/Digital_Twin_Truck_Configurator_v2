import { NextResponse } from "next/server";
import { query, getFullTableName } from "@/lib/snowflake";

interface SelectedOption {
  optionId: string;
  optionName: string;
  componentGroup: string;
  specs: Record<string, unknown> | null;
}

interface EngineeringDoc {
  docId: string;
  docTitle: string;
  docText: string;
  linkedPartId: string;
  linkedPartName: string;
}

interface Requirement {
  componentType: string;
  specName: string;
  minValue: number | null;
  maxValue: number | null;
  unit: string;
  rawRequirement: string;
}

export async function POST(request: Request) {
  const debugLog: string[] = [];
  const log = (msg: string) => {
    debugLog.push(msg);
  };

  try {
    const { selectedOptions, modelId } = await request.json();
    
    log(`=== VALIDATION DEBUG ===`);
    log(`Received ${selectedOptions?.length || 0} options for model ${modelId}`);
    
    if (!selectedOptions || !Array.isArray(selectedOptions) || selectedOptions.length === 0) {
      log("ERROR: No options provided");
      return NextResponse.json({ debugLog, error: "No options provided" });
    }
    
    // STEP 1: Check if option 134 (605 HP) is in the selection
    const has605HP = selectedOptions.includes("134");
    log(`\nSTEP 1: Checking if option 134 (605 HP) is selected: ${has605HP ? "YES" : "NO"}`);
    if (!has605HP) {
      log(`  Selected options (first 20): ${selectedOptions.slice(0, 20).join(', ')}`);
    }
    
    // STEP 2: Get all engineering docs
    log(`\nSTEP 2: Querying engineering docs...`);
    const docRows = await query<{
      DOC_ID: string;
      DOC_TITLE: string;
      LINKED_PARTS: string | null;
    }>(`
      SELECT DISTINCT DOC_ID, DOC_TITLE, LINKED_PARTS::VARCHAR as LINKED_PARTS
      FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
    `);
    
    log(`  Found ${docRows.length} docs:`);
    for (const doc of docRows) {
      log(`    - ${doc.DOC_TITLE} (ID: ${doc.DOC_ID})`);
      log(`      LINKED_PARTS: ${doc.LINKED_PARTS || 'null'}`);
      
      // Try to parse LINKED_PARTS
      if (doc.LINKED_PARTS) {
        try {
          const parts = JSON.parse(doc.LINKED_PARTS);
          log(`      Parsed: ${JSON.stringify(parts)}`);
          for (const part of parts) {
            const isSelected = selectedOptions.includes(part.optionId);
            log(`        Part ${part.optionId} (${part.optionName}): ${isSelected ? "SELECTED ✓" : "not selected"}`);
          }
        } catch (e) {
          log(`      Parse error: ${e}`);
        }
      }
      
      // Auto-detect for docs with empty LINKED_PARTS
      const hpMatch = doc.DOC_TITLE.match(/(\d{3,4})\s*[_-]?\s*HP/i);
      if (hpMatch) {
        log(`      Auto-detect HP pattern: ${hpMatch[1]}`);
        const results = await query<{ OPTION_ID: string; OPTION_NM: string }>(`
          SELECT OPTION_ID, OPTION_NM
          FROM ${getFullTableName('BOM_TBL')} 
          WHERE COMPONENT_GROUP = 'Power Rating' 
            AND OPTION_NM LIKE '%${hpMatch[1]}%HP%'
        `);
        log(`      Auto-detected ${results.length} matching parts:`);
        for (const r of results) {
          const isSelected = selectedOptions.includes(r.OPTION_ID);
          log(`        ${r.OPTION_ID}: ${r.OPTION_NM} - ${isSelected ? "SELECTED ✓" : "not selected"}`);
        }
      }
    }
    
    // STEP 3: Find which docs are linked to selected options
    log(`\nSTEP 3: Finding docs linked to selected parts...`);
    const linkedDocs: EngineeringDoc[] = [];
    
    for (const row of docRows) {
      let linkedParts: Array<{ optionId: string; optionName: string }> = [];
      
      if (row.LINKED_PARTS) {
        try {
          linkedParts = JSON.parse(row.LINKED_PARTS);
        } catch (e) {
          log(`  Failed to parse LINKED_PARTS for ${row.DOC_TITLE}`);
        }
      }
      
      // Auto-detect if empty
      if (linkedParts.length === 0) {
        const hpMatch = row.DOC_TITLE.match(/(\d{3,4})\s*[_-]?\s*HP/i);
        if (hpMatch) {
          const results = await query<{ OPTION_ID: string; OPTION_NM: string }>(`
            SELECT OPTION_ID, OPTION_NM
            FROM ${getFullTableName('BOM_TBL')} 
            WHERE COMPONENT_GROUP = 'Power Rating' 
              AND OPTION_NM LIKE '%${hpMatch[1]}%HP%'
          `);
          linkedParts = results.map(r => ({ optionId: r.OPTION_ID, optionName: r.OPTION_NM }));
        }
      }
      
      for (const part of linkedParts) {
        if (selectedOptions.includes(part.optionId)) {
          log(`  MATCH: Doc "${row.DOC_TITLE}" linked to selected part ${part.optionId} (${part.optionName})`);
          
          // Get doc text
          const chunks = await query<{ CHUNK_TEXT: string }>(`
            SELECT CHUNK_TEXT FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
            WHERE DOC_ID = '${row.DOC_ID.replace(/'/g, "''")}'
            ORDER BY CHUNK_INDEX
          `);
          
          linkedDocs.push({
            docId: row.DOC_ID,
            docTitle: row.DOC_TITLE,
            docText: chunks.map(c => c.CHUNK_TEXT).join('\n'),
            linkedPartId: part.optionId,
            linkedPartName: part.optionName
          });
          break;
        }
      }
    }
    
    log(`\n  Total linked docs found: ${linkedDocs.length}`);
    
    if (linkedDocs.length === 0) {
      return NextResponse.json({ 
        debugLog, 
        result: "No engineering docs linked to selected parts",
        selectedOptionsCount: selectedOptions.length,
        has605HP 
      });
    }
    
    // STEP 4: Get selected option details
    log(`\nSTEP 4: Getting option details...`);
    const quotedIds = selectedOptions.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
    const optionDetails = await query<{
      OPTION_ID: string;
      OPTION_NM: string;
      COMPONENT_GROUP: string;
      SPECS: string | null;
    }>(`
      SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, SPECS::VARCHAR as SPECS
      FROM ${getFullTableName('BOM_TBL')}
      WHERE OPTION_ID IN (${quotedIds})
    `);
    
    const optionInfo: SelectedOption[] = optionDetails.map(r => ({
      optionId: r.OPTION_ID,
      optionName: r.OPTION_NM,
      componentGroup: r.COMPONENT_GROUP,
      specs: r.SPECS ? JSON.parse(r.SPECS) : null
    }));
    
    log(`  Retrieved ${optionInfo.length} option details`);
    
    // STEP 5: Check each component group that requirements mention
    log(`\nSTEP 5: Extracting requirements and checking compliance...`);
    
    const componentGroups = ['Turbocharger', 'Radiator', 'Transmission Type', 'Engine Brake Type'];
    for (const cg of componentGroups) {
      const part = optionInfo.find(o => o.componentGroup === cg);
      if (part) {
        log(`  ${cg}: ${part.optionName} (ID: ${part.optionId})`);
        log(`    Specs: ${JSON.stringify(part.specs)}`);
      } else {
        log(`  ${cg}: NO PART SELECTED`);
      }
    }
    
    // STEP 6: For the first linked doc, extract requirements with AI
    const doc = linkedDocs[0];
    log(`\nSTEP 6: Extracting requirements from "${doc.docTitle}"...`);
    log(`  Doc text preview (first 500 chars): ${doc.docText.substring(0, 500)}`);
    
    const KNOWN_SPEC_NAMES: Record<string, { specNames: string[]; componentGroup: string; description: string }> = {
      'turbocharger': {
        specNames: ['boost_psi', 'max_hp_supported'],
        componentGroup: 'Turbocharger',
        description: 'boost_psi = max boost pressure, max_hp_supported = maximum HP rating'
      },
      'radiator': {
        specNames: ['cooling_capacity_btu', 'core_rows'],
        componentGroup: 'Radiator',
        description: 'cooling_capacity_btu = BTU heat rejection capacity, core_rows = number of cooling rows'
      },
      'transmission': {
        specNames: ['torque_rating_lb_ft', 'gear_count'],
        componentGroup: 'Transmission Type',
        description: 'torque_rating_lb_ft = max torque capacity, gear_count = number of forward gears'
      },
      'engine_brake': {
        specNames: ['braking_hp', 'brake_stages'],
        componentGroup: 'Engine Brake Type',
        description: 'braking_hp = braking horsepower, brake_stages = number of brake stages'
      }
    };
    
    const specReference = Object.entries(KNOWN_SPEC_NAMES)
      .map(([type, info]) => `- ${info.componentGroup}: ${info.specNames.join(', ')} (${info.description})`)
      .join('\n');
    
    const prompt = `Analyze this engineering specification document for "${doc.linkedPartName}" and extract ALL component requirements.

DOCUMENT:
${doc.docText.substring(0, 8000)}

This document specifies what OTHER components are needed to be compatible with "${doc.linkedPartName}".

IMPORTANT: Use these EXACT spec names from our parts database:
${specReference}

For each requirement found, extract:
1. componentType: The component group name EXACTLY as shown (Turbocharger, Radiator, Transmission Type, Engine Brake Type)
2. specName: The EXACT spec name (e.g., "boost_psi", "max_hp_supported", "torque_rating_lb_ft", "braking_hp", "cooling_capacity_btu")
3. minValue: The minimum required value (number only, no commas)
4. maxValue: The maximum allowed value (null if no maximum)
5. unit: The unit
6. rawRequirement: The original text

Return ONLY a valid JSON array.`;
    
    const aiResults = await query<{ RESPONSE: string }>(`
      SELECT SNOWFLAKE.CORTEX.COMPLETE('mistral-large2', '${prompt.replace(/'/g, "''")}') AS RESPONSE
    `);
    
    let requirements: Requirement[] = [];
    if (aiResults.length > 0) {
      log(`\n  AI Response: ${aiResults[0].RESPONSE.substring(0, 1000)}...`);
      const jsonMatch = aiResults[0].RESPONSE.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          requirements = JSON.parse(jsonMatch[0]);
          log(`\n  Parsed ${requirements.length} requirements:`);
          for (const req of requirements) {
            log(`    - ${req.componentType}: ${req.specName} >= ${req.minValue}`);
          }
        } catch (e) {
          log(`  JSON parse error: ${e}`);
        }
      } else {
        log(`  No JSON array found in AI response`);
      }
    }
    
    // STEP 7: Check compliance
    log(`\nSTEP 7: Checking compliance...`);
    const issues: Array<{
      componentGroup: string;
      currentPart: string;
      specName: string;
      currentValue: number | null;
      requiredValue: number | null;
      compliant: boolean;
    }> = [];
    
    for (const req of requirements) {
      const currentPart = optionInfo.find(o => o.componentGroup === req.componentType);
      if (!currentPart) {
        log(`  ${req.componentType}: No part selected`);
        continue;
      }
      
      const specs = currentPart.specs || {};
      const currentValue = specs[req.specName] as number | undefined;
      
      if (currentValue === undefined) {
        log(`  ${req.componentType}.${req.specName}: Spec not found in ${currentPart.optionName}`);
        issues.push({
          componentGroup: req.componentType,
          currentPart: currentPart.optionName,
          specName: req.specName,
          currentValue: null,
          requiredValue: req.minValue,
          compliant: true // Can't check what we don't have
        });
        continue;
      }
      
      const compliant = currentValue >= (req.minValue || 0);
      log(`  ${req.componentType}.${req.specName}: ${currentValue} vs required ${req.minValue} - ${compliant ? "PASS ✓" : "FAIL ✗"}`);
      issues.push({
        componentGroup: req.componentType,
        currentPart: currentPart.optionName,
        specName: req.specName,
        currentValue,
        requiredValue: req.minValue,
        compliant
      });
    }
    
    const failures = issues.filter(i => !i.compliant);
    log(`\n=== RESULT: ${failures.length} failures out of ${issues.length} checks ===`);
    
    return NextResponse.json({
      debugLog,
      selectedOptionsCount: selectedOptions.length,
      has605HP,
      linkedDocsCount: linkedDocs.length,
      linkedDocTitle: linkedDocs[0]?.docTitle,
      requirementsCount: requirements.length,
      requirements: requirements.map(r => ({ componentType: r.componentType, specName: r.specName, minValue: r.minValue })),
      complianceChecks: issues,
      failures,
      verdict: failures.length > 0 ? "INVALID" : "VALID"
    });
    
  } catch (error) {
    log(`ERROR: ${error}`);
    return NextResponse.json({ 
      debugLog, 
      error: String(error) 
    });
  }
}
