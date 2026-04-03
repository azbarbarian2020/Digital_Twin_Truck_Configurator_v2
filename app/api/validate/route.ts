import { NextResponse } from "next/server";
import { query, getFullTableName } from "@/lib/snowflake";

interface SelectedOption {
  optionId: string;
  optionName: string;
  componentGroup: string;
  specs: Record<string, unknown> | null;
}

interface ValidationIssue {
  type: string;
  title: string;
  message: string;
  relatedOptions: string[];
  sourceDoc?: string;
  specMismatches?: Array<{ specName: string; currentValue: number | null; requiredValue: number | null; reason: string }>;
}

interface FixPlan {
  remove: string[];
  add: string[];
  explanation: string;
}

export async function POST(request: Request) {
  console.log("\n=== VALIDATION API CALLED ===");
  try {
    const { selectedOptions, modelId, incrementalOnly } = await request.json();
    
    console.log(`Validating ${selectedOptions?.length || 0} options for model ${modelId}`);
    console.log(`Selected option IDs: ${selectedOptions?.slice(0, 10).join(', ')}${selectedOptions?.length > 10 ? '...' : ''}`);
    
    if (!selectedOptions || !Array.isArray(selectedOptions) || selectedOptions.length === 0) {
      console.log("No options to validate - returning empty");
      return NextResponse.json({ issues: [], suggestions: [], fixPlan: { remove: [], add: [], explanation: "" } });
    }
    
    const optionInfo = await getOptionDetails(selectedOptions);
    
    const allIssues: ValidationIssue[] = [];
    const allRemoves: string[] = [];
    const allAdds: string[] = [];
    const allExplanations: string[] = [];

    // Find engineering docs linked to selected parts
    // In incremental mode, only check docs linked to incrementalOnly options
    const optionsToCheck = incrementalOnly && Array.isArray(incrementalOnly) && incrementalOnly.length > 0
      ? incrementalOnly
      : selectedOptions;
    
    const docsForSelectedParts = await findDocsLinkedToSelectedParts(optionsToCheck);
    
    console.log(`Found ${docsForSelectedParts.length} engineering docs linked to ${incrementalOnly ? 'newly added' : 'selected'} parts`);

    // Validate all docs in PARALLEL for faster processing
    const validationResults = await Promise.all(
      docsForSelectedParts.map(doc => 
        validateAgainstEngineeringDoc(doc, optionInfo, modelId)
      )
    );
    
    // Collect results from parallel validations
    for (const result of validationResults) {
      allIssues.push(...result.issues);
      allRemoves.push(...result.fixPlan.remove);
      allAdds.push(...result.fixPlan.add);
      if (result.fixPlan.explanation) {
        allExplanations.push(result.fixPlan.explanation);
      }
    }
    
    // Deduplicate issues by component (same part can be flagged by multiple docs)
    const seenIssues = new Set<string>();
    const deduplicatedIssues = allIssues.filter(issue => {
      const key = issue.relatedOptions[0]; // First related option is the incompatible part
      if (seenIssues.has(key)) return false;
      seenIssues.add(key);
      return true;
    });
    
    // Deduplicate: fetch all component groups in parallel, then filter
    const uniqueAdds = [...new Set(allAdds)];
    const componentGroupResults = await Promise.all(
      uniqueAdds.map(async addId => {
        const opt = await query<{ COMPONENT_GROUP: string }>(`
          SELECT COMPONENT_GROUP FROM ${getFullTableName('BOM_TBL')} WHERE OPTION_ID = '${addId}'
        `);
        return { addId, componentGroup: opt.length > 0 ? opt[0].COMPONENT_GROUP : null };
      })
    );
    
    const seenGroups = new Set<string>();
    const deduplicatedAdds: string[] = [];
    for (const { addId, componentGroup } of componentGroupResults) {
      if (componentGroup && !seenGroups.has(componentGroup)) {
        seenGroups.add(componentGroup);
        deduplicatedAdds.push(addId);
      }
    }
    
    return NextResponse.json({ 
      issues: deduplicatedIssues, 
      suggestions: [],
      fixPlan: {
        remove: [...new Set(allRemoves)],
        add: deduplicatedAdds,
        explanation: [...new Set(allExplanations)].join('\n\n')
      }
    });
  } catch (error) {
    console.error("Error validating:", error);
    return NextResponse.json({ issues: [], suggestions: [], fixPlan: { remove: [], add: [], explanation: "" } });
  }
}

async function getOptionDetails(optionIds: string[]): Promise<SelectedOption[]> {
  const quotedIds = optionIds.map(id => `'${id.replace(/'/g, "''")}'`).join(",");
  
  const results = await query<{
    OPTION_ID: string;
    OPTION_NM: string;
    COMPONENT_GROUP: string;
    SPECS: string | null;
  }>(`
    SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, SPECS::VARCHAR as SPECS
    FROM ${getFullTableName('BOM_TBL')}
    WHERE OPTION_ID IN (${quotedIds})
  `);
  
  return results.map(r => ({
    optionId: r.OPTION_ID,
    optionName: r.OPTION_NM,
    componentGroup: r.COMPONENT_GROUP,
    specs: r.SPECS ? JSON.parse(r.SPECS) : null
  }));
}

interface EngineeringDoc {
  docId: string;
  docTitle: string;
  docText: string;
  linkedPartId: string;
  linkedPartName: string;
}

async function findDocsLinkedToSelectedParts(selectedOptionIds: string[]): Promise<EngineeringDoc[]> {
  const docs: EngineeringDoc[] = [];
  console.log(`Looking for docs linked to options: ${selectedOptionIds.slice(0, 5).join(', ')}...`);
  
  // Get ALL engineering docs (we'll auto-detect linked parts if not set)
  const docRows = await query<{
    DOC_ID: string;
    DOC_TITLE: string;
    LINKED_PARTS: string | null;
  }>(`
    SELECT DISTINCT DOC_ID, DOC_TITLE, LINKED_PARTS::VARCHAR as LINKED_PARTS
    FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
  `);
  
  console.log(`Found ${docRows.length} engineering docs in database`);
  
  for (const row of docRows) {
    let linkedParts: Array<{ optionId: string; optionName: string }> = [];
    
    // Try to parse existing LINKED_PARTS
    if (row.LINKED_PARTS) {
      try {
        linkedParts = JSON.parse(row.LINKED_PARTS);
        console.log(`  Doc "${row.DOC_TITLE}": parsed LINKED_PARTS = ${JSON.stringify(linkedParts)}`);
      } catch (e) {
        console.log(`Failed to parse LINKED_PARTS for ${row.DOC_TITLE}, will auto-detect`);
      }
    }
    
    // Auto-detect if LINKED_PARTS is empty or null
    if (linkedParts.length === 0) {
      linkedParts = await detectLinkedPartsForDoc(row.DOC_TITLE);
      console.log(`Auto-detected ${linkedParts.length} linked parts for ${row.DOC_TITLE}:`, linkedParts);
    }
    
    // Check if any linked part is in our selected options
    for (const part of linkedParts) {
      if (selectedOptionIds.includes(part.optionId)) {
        // Get the full doc text
        const chunks = await query<{ CHUNK_TEXT: string }>(`
          SELECT CHUNK_TEXT FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
          WHERE DOC_ID = '${row.DOC_ID.replace(/'/g, "''")}'
          ORDER BY CHUNK_INDEX
        `);
        
        docs.push({
          docId: row.DOC_ID,
          docTitle: row.DOC_TITLE,
          docText: chunks.map(c => c.CHUNK_TEXT).join('\n'),
          linkedPartId: part.optionId,
          linkedPartName: part.optionName
        });
        break; // Only add doc once even if multiple linked parts are selected
      }
    }
  }
  
  return docs;
}

// Auto-detect linked parts based on doc title (same logic as engineering-docs GET route)
async function detectLinkedPartsForDoc(docTitle: string): Promise<Array<{ optionId: string; optionName: string }>> {
  const linkedParts: Array<{ optionId: string; optionName: string }> = [];

  // Match HP patterns like "605 HP" or "605_HP"
  const hpMatch = docTitle.match(/(\d{3,4})\s*[_-]?\s*HP/i);
  if (hpMatch) {
    const hp = hpMatch[1];
    const results = await query<{ OPTION_ID: string; OPTION_NM: string }>(`
      SELECT OPTION_ID, OPTION_NM
      FROM ${getFullTableName('BOM_TBL')} 
      WHERE COMPONENT_GROUP = 'Power Rating' 
        AND OPTION_NM LIKE '%${hp}%HP%'
    `);
    for (const r of results) {
      linkedParts.push({ optionId: r.OPTION_ID, optionName: r.OPTION_NM });
    }
  }

  // Match axle weight patterns like "20,000 lb" or "20000_lb"
  const axleMatch = docTitle.match(/(\d{1,2}),?(\d{3})\s*[_-]?\s*lb/i);
  if (axleMatch) {
    const weight = axleMatch[1] + axleMatch[2];
    const formattedWeight = parseInt(weight).toLocaleString();
    const results = await query<{ OPTION_ID: string; OPTION_NM: string }>(`
      SELECT OPTION_ID, OPTION_NM
      FROM ${getFullTableName('BOM_TBL')} 
      WHERE COMPONENT_GROUP = 'Axle Rating' 
        AND (OPTION_NM LIKE '%${weight}%' OR OPTION_NM LIKE '%${formattedWeight}%')
    `);
    for (const r of results) {
      linkedParts.push({ optionId: r.OPTION_ID, optionName: r.OPTION_NM });
    }
  }

  return linkedParts;
}

async function validateAgainstEngineeringDoc(
  doc: EngineeringDoc,
  allSelectedOptions: SelectedOption[],
  modelId?: string
): Promise<{ issues: ValidationIssue[]; fixPlan: FixPlan }> {
  console.log(`\n=== VALIDATING AGAINST: ${doc.docTitle} (linked to ${doc.linkedPartName}) ===`);
  
  // Extract requirements from the doc - these specify what OTHER components need
  const requirements = await extractRequirementsWithAI(doc.docText, doc.linkedPartName);
  
  if (!requirements || requirements.length === 0) {
    console.log("No requirements extracted from doc");
    return { issues: [], fixPlan: { remove: [], add: [], explanation: "" } };
  }
  
  console.log(`Extracted ${requirements.length} requirements:`, JSON.stringify(requirements, null, 2));
  
  // Group requirements by component group
  const reqsByComponentGroup = new Map<string, Requirement[]>();
  for (const req of requirements) {
    const componentGroup = mapRequirementToComponentGroup(req.componentType);
    if (!reqsByComponentGroup.has(componentGroup)) {
      reqsByComponentGroup.set(componentGroup, []);
    }
    reqsByComponentGroup.get(componentGroup)!.push(req);
  }
  
  const issues: ValidationIssue[] = [];
  const toRemove: string[] = [];
  const toAdd: string[] = [];
  const explanations: string[] = [];
  
  for (const [componentGroup, groupReqs] of reqsByComponentGroup) {
    const currentPart = allSelectedOptions.find(o => o.componentGroup === componentGroup);
    
    if (!currentPart) {
      console.log(`No part selected for ${componentGroup}`);
      continue;
    }
    
    console.log(`Checking ${currentPart.optionName} against ${groupReqs.length} requirements for ${componentGroup}`);
    
    const specMismatches: Array<{ specName: string; currentValue: number | null; requiredValue: number | null; reason: string }> = [];
    const failedReqs: Requirement[] = [];
    
    for (const req of groupReqs) {
      const complianceCheck = checkComplianceDirectly(req, currentPart);
      
      if (!complianceCheck.compliant) {
        specMismatches.push({
          specName: req.specName,
          currentValue: complianceCheck.currentValue,
          requiredValue: req.minValue,
          reason: complianceCheck.reason
        });
        failedReqs.push(req);
      }
    }
    
    if (specMismatches.length > 0) {
      const issueMessages = specMismatches.map(m => m.reason).join('; ');
      
      issues.push({
        type: "error",
        title: `${currentPart.optionName} Incompatible`,
        message: `Per ${doc.linkedPartName} spec: ${issueMessages}`,
        relatedOptions: [currentPart.optionId, doc.linkedPartId],
        sourceDoc: doc.docTitle,
        specMismatches
      });
      
      // Find the CHEAPEST part in this component group that meets ALL requirements
      const replacement = await findCheapestCompliantPart(
        groupReqs, // Use ALL requirements for this group, not just failed ones
        componentGroup,
        modelId
      );
      
      if (replacement) {
        toRemove.push(currentPart.optionId);
        toAdd.push(replacement.optionId);
        explanations.push(`Replace ${currentPart.optionName} with ${replacement.optionName} ($${replacement.cost.toLocaleString()} - cheapest option meeting all requirements)`);
      }
    }
  }
  
  return {
    issues,
    fixPlan: {
      remove: [...new Set(toRemove)],
      add: [...new Set(toAdd)],
      explanation: explanations.length > 0
        ? `Per "${doc.docTitle}" requirements for ${doc.linkedPartName}:\n• ${explanations.join('\n• ')}`
        : ""
    }
  };
}

interface Requirement {
  componentType: string;
  specName: string;
  minValue: number | null;
  maxValue: number | null;
  unit: string;
  rawRequirement: string;
}

const KNOWN_SPEC_NAMES: Record<string, { specNames: string[]; componentGroup: string; description: string }> = {
  'turbocharger': {
    specNames: ['boost_psi', 'max_hp_supported'],
    componentGroup: 'Turbocharger',
    description: 'boost_psi = boost pressure in PSI, max_hp_supported = max horsepower the turbo can support'
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
  },
  'front_brakes': {
    specNames: ['gawr_rating_lb', 'brake_type'],
    componentGroup: 'Front Brake Type',
    description: 'gawr_rating_lb = gross axle weight rating capacity'
  },
  'steering': {
    specNames: ['max_axle_weight_lb'],
    componentGroup: 'Steering Gear',
    description: 'max_axle_weight_lb = max axle weight steering can handle'
  },
  'front_suspension': {
    specNames: ['spring_rating_lb'],
    componentGroup: 'Front Suspension Type',
    description: 'spring_rating_lb = max spring load capacity'
  }
};

async function extractRequirementsWithAI(docText: string, linkedPartName: string): Promise<Requirement[]> {
  const specReference = Object.entries(KNOWN_SPEC_NAMES)
    .map(([type, info]) => `- ${info.componentGroup}: ${info.specNames.join(', ')} (${info.description})`)
    .join('\n');

  const prompt = `Analyze this engineering specification document for "${linkedPartName}" and extract ALL component requirements.

DOCUMENT:
${docText.substring(0, 8000)}

This document specifies what OTHER components are needed to be compatible with "${linkedPartName}".

The document may contain requirements in formats like:
- "spec_name >= value" (e.g., "boost_psi >= 40")
- "spec_name: minimum value" (e.g., "Cooling Capacity: 350000 BTU")
- Natural language (e.g., "must support at least 605 HP")

IMPORTANT: Use these EXACT spec names from our parts database:
${specReference}

For each requirement found, extract:
1. componentType: The component group name EXACTLY as shown (Turbocharger, Radiator, Transmission Type, Engine Brake Type, etc.)
2. specName: The EXACT spec name (e.g., "boost_psi", "max_hp_supported", "torque_rating_lb_ft", "braking_hp", "cooling_capacity_btu")
3. minValue: The minimum required value (number only, no commas)
4. maxValue: The maximum allowed value (null if no maximum)
5. unit: The unit (BTU, HP, lb-ft, PSI, etc.)
6. rawRequirement: The original text

Return ONLY a valid JSON array. Example:
[
  {"componentType": "Turbocharger", "specName": "boost_psi", "minValue": 40, "maxValue": null, "unit": "PSI", "rawRequirement": "boost_psi >= 40"},
  {"componentType": "Turbocharger", "specName": "max_hp_supported", "minValue": 605, "maxValue": null, "unit": "HP", "rawRequirement": "max_hp_supported >= 605"},
  {"componentType": "Radiator", "specName": "cooling_capacity_btu", "minValue": 350000, "maxValue": null, "unit": "BTU", "rawRequirement": "cooling_capacity_btu >= 350000"},
  {"componentType": "Engine Brake Type", "specName": "braking_hp", "minValue": 600, "maxValue": null, "unit": "HP", "rawRequirement": "braking_hp >= 600"}
]

Return [] if no component requirements are found.`;

  try {
    const results = await query<{ RESPONSE: string }>(`
      SELECT SNOWFLAKE.CORTEX.COMPLETE('mistral-large2', '${prompt.replace(/'/g, "''")}') AS RESPONSE
    `);
    
    if (!results.length) return [];
    
    let response = results[0].RESPONSE.trim();
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch (error) {
    console.error("Failed to extract requirements:", error);
    return [];
  }
}

interface ComplianceResult {
  compliant: boolean;
  reason: string;
  currentValue: number | null;
}

function checkComplianceDirectly(
  requirement: Requirement,
  currentPart: SelectedOption
): ComplianceResult {
  const specs = currentPart.specs || {};
  
  // Map of spec name aliases for flexible matching
  const specAliases: Record<string, string[]> = {
    'cooling_capacity_btu': ['cooling_capacity_btu'],
    'core_rows': ['core_rows'],
    'max_hp_supported': ['max_hp_supported'],
    'boost_psi': ['boost_psi'],
    'torque_rating_lb_ft': ['torque_rating_lb_ft', 'max_torque_capacity_lb_ft', 'torque_capacity_lb_ft'],
    'gear_count': ['gear_count'],
    'braking_hp': ['braking_hp'],
    'brake_stages': ['brake_stages'],
    'gawr_rating_lb': ['gawr_lb', 'gawr_rating_lb'],
    'spring_rating_lb': ['spring_rating_lb'],
    'max_axle_weight_lb': ['max_axle_weight_lb', 'axle_capacity_lb'],
  };
  
  const possibleNames = specAliases[requirement.specName] || [requirement.specName];
  
  for (const specName of possibleNames) {
    if (specName in specs) {
      const value = specs[specName] as number;
      if (requirement.minValue !== null) {
        if (value >= requirement.minValue) {
          console.log(`  ✓ ${specName}=${value.toLocaleString()} >= ${requirement.minValue.toLocaleString()} ✓`);
          return {
            compliant: true,
            reason: `has ${value.toLocaleString()} ${requirement.unit}`,
            currentValue: value
          };
        } else {
          console.log(`  ✗ ${specName}=${value.toLocaleString()} < ${requirement.minValue.toLocaleString()} ✗`);
          return {
            compliant: false,
            reason: `has ${value.toLocaleString()} ${requirement.unit} but needs ${requirement.minValue.toLocaleString()} ${requirement.unit}`,
            currentValue: value
          };
        }
      }
    }
  }
  
  console.log(`  ? Spec ${requirement.specName} not found in ${currentPart.optionName}`);
  return {
    compliant: true, // Can't fail what we can't check
    reason: `spec ${requirement.specName} not found`,
    currentValue: null
  };
}

interface ReplacementPart {
  optionId: string;
  optionName: string;
  cost: number;
  reason: string;
}

async function findCheapestCompliantPart(
  requirements: Requirement[],
  componentGroup: string,
  modelId?: string
): Promise<ReplacementPart | null> {
  // Query all parts in this component group, ordered by cost (cheapest first)
  const candidatesQuery = modelId ? `
    SELECT b.OPTION_ID, b.OPTION_NM, b.SPECS::VARCHAR as SPECS, b.COST_USD
    FROM ${getFullTableName('BOM_TBL')} b
    JOIN ${getFullTableName('TRUCK_OPTIONS')} t ON b.OPTION_ID = t.OPTION_ID
    WHERE b.COMPONENT_GROUP = '${componentGroup.replace(/'/g, "''")}'
      AND t.MODEL_ID = '${modelId}'
    ORDER BY b.COST_USD ASC
  ` : `
    SELECT OPTION_ID, OPTION_NM, SPECS::VARCHAR as SPECS, COST_USD
    FROM ${getFullTableName('BOM_TBL')}
    WHERE COMPONENT_GROUP = '${componentGroup.replace(/'/g, "''")}'
    ORDER BY COST_USD ASC
  `;
  
  console.log(`\n  Finding cheapest ${componentGroup} meeting ${requirements.length} requirements...`);
  
  try {
    const candidates = await query<{
      OPTION_ID: string;
      OPTION_NM: string;
      SPECS: string;
      COST_USD: number;
    }>(candidatesQuery);
    
    if (candidates.length === 0) {
      console.log(`  No candidates found for ${componentGroup}`);
      return null;
    }
    
    console.log(`  Evaluating ${candidates.length} candidates (sorted by cost)...`);
    
    // Spec aliases for matching
    const specAliases: Record<string, string[]> = {
      'cooling_capacity_btu': ['cooling_capacity_btu'],
      'core_rows': ['core_rows'],
      'max_hp_supported': ['max_hp_supported'],
      'boost_psi': ['boost_psi'],
      'torque_rating_lb_ft': ['torque_rating_lb_ft', 'max_torque_capacity_lb_ft', 'torque_capacity_lb_ft'],
      'gear_count': ['gear_count'],
      'braking_hp': ['braking_hp'],
      'brake_stages': ['brake_stages'],
      'gawr_rating_lb': ['gawr_lb', 'gawr_rating_lb'],
      'spring_rating_lb': ['spring_rating_lb'],
      'max_axle_weight_lb': ['max_axle_weight_lb', 'axle_capacity_lb'],
    };
    
    // Check each candidate (already sorted by cost, so first match is cheapest)
    for (const candidate of candidates) {
      const specs = candidate.SPECS ? JSON.parse(candidate.SPECS) : {};
      let meetsAllRequirements = true;
      const metSpecs: string[] = [];
      
      for (const req of requirements) {
        if (req.minValue === null) continue;
        
        const possibleNames = specAliases[req.specName] || [req.specName];
        let meetsThisReq = false;
        
        for (const specName of possibleNames) {
          if (specName in specs) {
            const value = specs[specName] as number;
            if (value >= req.minValue) {
              meetsThisReq = true;
              metSpecs.push(`${value.toLocaleString()} ${req.unit} ${req.specName}`);
              break;
            }
          }
        }
        
        if (!meetsThisReq) {
          meetsAllRequirements = false;
          break;
        }
      }
      
      if (meetsAllRequirements) {
        console.log(`  ✓ CHEAPEST: ${candidate.OPTION_NM} ($${candidate.COST_USD.toLocaleString()}) meets all requirements`);
        return {
          optionId: candidate.OPTION_ID,
          optionName: candidate.OPTION_NM,
          cost: candidate.COST_USD,
          reason: metSpecs.join(', ')
        };
      }
    }
    
    console.log(`  ✗ No ${componentGroup} meets all requirements`);
    return null;
  } catch (error) {
    console.error("Failed to find replacement:", error);
    return null;
  }
}

function mapRequirementToComponentGroup(componentType: string): string {
  // Direct mapping - the AI should return these exact names
  const mappings: Record<string, string> = {
    'radiator': 'Radiator',
    'turbocharger': 'Turbocharger',
    'turbo': 'Turbocharger',
    'transmission': 'Transmission Type',
    'transmission type': 'Transmission Type',
    'engine brake': 'Engine Brake Type',
    'engine brake type': 'Engine Brake Type',
    'front brakes': 'Front Brake Type',
    'front brake type': 'Front Brake Type',
    'steering': 'Steering Gear',
    'steering gear': 'Steering Gear',
    'front suspension': 'Front Suspension Type',
    'front suspension type': 'Front Suspension Type',
  };
  
  const lower = componentType.toLowerCase();
  return mappings[lower] || componentType;
}
