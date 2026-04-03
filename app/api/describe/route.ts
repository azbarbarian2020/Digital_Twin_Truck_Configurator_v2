import { NextResponse } from "next/server";
import { query, getFullTableName } from "@/lib/snowflake";

interface BOMOption {
  OPTION_ID: string;
  OPTION_NM: string;
  PERFORMANCE_CATEGORY: string;
  PERFORMANCE_SCORE: number;
  SYSTEM_NM: string;
  COMPONENT_GROUP: string;
  OPTION_TIER: string;
  COST_USD: number;
  WEIGHT_LBS: number;
}

interface ModelInfo {
  MODEL_ID: string;
  MODEL_NM: string;
  TRUCK_DESCRIPTION: string;
  BASE_MSRP: number;
  BASE_WEIGHT_LBS: number;
}

interface DefaultOption {
  OPTION_ID: string;
  COST_USD: number;
  WEIGHT_LBS: number;
  OPTION_NM: string;
  COMPONENT_GROUP: string;
  PERFORMANCE_CATEGORY: string;
  PERFORMANCE_SCORE: number;
}

function getModelIdFromName(modelName: string): string {
  if (modelName.includes('RT-500')) return 'MDL-REGIONAL';
  if (modelName.includes('FW-700')) return 'MDL-FLEET';
  if (modelName.includes('CC-900')) return 'MDL-LONGHAUL';
  if (modelName.includes('HH-1200')) return 'MDL-HEAVYHAUL';
  if (modelName.includes('EX-1500')) return 'MDL-PREMIUM';
  return 'MDL-FLEET';
}

function extractFirstSentence(text: string): string {
  const match = text.match(/^[^.!?]*[.!?]/);
  return match ? match[0].trim() : text.substring(0, 100) + "...";
}

interface ConfigAnalysis {
  // What categories were upgraded (high scores selected)
  upgradedCategories: string[];
  // What categories were downgraded (low cost options selected)
  downgradedCategories: string[];
  // Notable premium components by name
  premiumComponents: { name: string; type: string; category: string }[];
  // Cost analysis
  costSavings: number;
  costIncrease: number;
  // Weight analysis
  weightSavings: number;
  weightIncrease: number;
  // Specific notable items
  engineName: string | null;
  turboName: string | null;
  transmissionName: string | null;
  // Category scores
  categoryScores: Record<string, number>;
}

function analyzeConfiguration(
  selectedOptions: BOMOption[],
  defaultOptions: DefaultOption[],
  performanceSummary: Record<string, number>
): ConfigAnalysis {
  const defaultById = new Map(defaultOptions.map(d => [d.OPTION_ID, d]));
  const defaultByGroup = new Map(defaultOptions.map(d => [d.COMPONENT_GROUP, d]));
  
  const analysis: ConfigAnalysis = {
    upgradedCategories: [],
    downgradedCategories: [],
    premiumComponents: [],
    costSavings: 0,
    costIncrease: 0,
    weightSavings: 0,
    weightIncrease: 0,
    engineName: null,
    turboName: null,
    transmissionName: null,
    categoryScores: performanceSummary || {}
  };
  
  // Track upgrades and downgrades by category
  const categoryUpgrades: Record<string, number> = {};
  const categoryDowngrades: Record<string, number> = {};
  
  for (const opt of selectedOptions) {
    const wasDefault = defaultById.has(opt.OPTION_ID);
    const defaultInGroup = defaultByGroup.get(opt.COMPONENT_GROUP);
    
    // Check for notable named components
    const nameLower = opt.OPTION_NM.toLowerCase();
    const groupLower = opt.COMPONENT_GROUP.toLowerCase();
    
    if (groupLower.includes('engine') && !groupLower.includes('brake')) {
      analysis.engineName = opt.OPTION_NM;
    }
    if (groupLower.includes('turbo')) {
      analysis.turboName = opt.OPTION_NM;
    }
    if (groupLower.includes('transmission')) {
      analysis.transmissionName = opt.OPTION_NM;
    }
    
    // Skip if this was a default option
    if (wasDefault) continue;
    
    // Compare to what was default in this component group
    if (defaultInGroup) {
      const costDiff = opt.COST_USD - defaultInGroup.COST_USD;
      const scoreDiff = opt.PERFORMANCE_SCORE - defaultInGroup.PERFORMANCE_SCORE;
      
      if (costDiff > 0) {
        analysis.costIncrease += costDiff;
      } else if (costDiff < 0) {
        analysis.costSavings += Math.abs(costDiff);
      }
      
      // Track category changes
      const cat = opt.PERFORMANCE_CATEGORY;
      if (scoreDiff > 0.5) {
        categoryUpgrades[cat] = (categoryUpgrades[cat] || 0) + 1;
      } else if (scoreDiff < -0.5) {
        categoryDowngrades[cat] = (categoryDowngrades[cat] || 0) + 1;
      }
      
      // Is this a premium upgrade?
      if (opt.PERFORMANCE_SCORE >= 4 || opt.OPTION_TIER === 'Premium' || costDiff > 2000) {
        analysis.premiumComponents.push({
          name: opt.OPTION_NM,
          type: groupLower.includes('engine') ? 'engine' :
                groupLower.includes('turbo') ? 'turbocharger' :
                groupLower.includes('transmission') ? 'transmission' :
                groupLower.includes('radiator') ? 'radiator' :
                groupLower.includes('brake') ? 'brake system' :
                'component',
          category: cat
        });
      }
    }
  }
  
  // Determine which categories were upgraded vs downgraded
  for (const [cat, count] of Object.entries(categoryUpgrades)) {
    if (count >= 1 && (!categoryDowngrades[cat] || categoryUpgrades[cat] > categoryDowngrades[cat])) {
      analysis.upgradedCategories.push(cat);
    }
  }
  
  for (const [cat, count] of Object.entries(categoryDowngrades)) {
    if (count >= 2 && (!categoryUpgrades[cat] || categoryDowngrades[cat] > categoryUpgrades[cat])) {
      analysis.downgradedCategories.push(cat);
    }
  }
  
  return analysis;
}

async function callCortexComplete(prompt: string): Promise<string> {
  const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || 'sjb01014.snowflakecomputing.com';
  const token = process.env.SNOWFLAKE_TOKEN;
  
  if (!token) {
    throw new Error("No Snowflake token available");
  }
  
  const response = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/cortex/inference:complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Snowflake Token="${token}"`,
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 350,
      temperature: 0.7
    })
  });
  
  if (!response.ok) {
    throw new Error(`Cortex API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function POST(request: Request) {
  try {
    const { modelName, selectedOptions, totalCost, totalWeight, performanceSummary, optimizationHistory } = await request.json();
    
    if (!selectedOptions || selectedOptions.length === 0) {
      return NextResponse.json({ 
        description: "Custom truck configuration with standard options.",
        isCortexGenerated: false 
      });
    }

    const modelId = getModelIdFromName(modelName);
    const modelResult = await query<ModelInfo>(`
      SELECT MODEL_ID, MODEL_NM, TRUCK_DESCRIPTION, BASE_MSRP, BASE_WEIGHT_LBS
      FROM ${getFullTableName('MODEL_TBL')}
      WHERE MODEL_ID = '${modelId}'
    `);
    
    const baseDescription = modelResult[0]?.TRUCK_DESCRIPTION || "";
    const baseMSRP = modelResult[0]?.BASE_MSRP || 0;
    const baseWeight = modelResult[0]?.BASE_WEIGHT_LBS || 0;
    const baseIntro = extractFirstSentence(baseDescription);
    
    // Get default options with their categories and scores
    const defaultOptionsResult = await query<DefaultOption>(`
      SELECT t.OPTION_ID, b.COST_USD, b.WEIGHT_LBS, b.OPTION_NM, b.COMPONENT_GROUP, b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE
      FROM ${getFullTableName('TRUCK_OPTIONS')} t
      JOIN ${getFullTableName('BOM_TBL')} b ON t.OPTION_ID = b.OPTION_ID
      WHERE t.MODEL_ID = '${modelId}' AND t.IS_DEFAULT = TRUE
    `);
    const defaultCost = defaultOptionsResult.reduce((sum, o) => sum + o.COST_USD, 0);
    const defaultWeight = defaultOptionsResult.reduce((sum, o) => sum + (o.WEIGHT_LBS || 0), 0);
    const defaultTotalCost = baseMSRP + defaultCost;
    const defaultTotalWeight = baseWeight + defaultWeight;
    
    // Get full details of selected options
    const optionDetails = await query<BOMOption>(`
      SELECT OPTION_ID, OPTION_NM, PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, SYSTEM_NM, COMPONENT_GROUP, OPTION_TIER, COST_USD, WEIGHT_LBS
      FROM ${getFullTableName('BOM_TBL')}
      WHERE OPTION_ID IN (${selectedOptions.map((id: string) => `'${id}'`).join(',')})
    `);
    
    const costVsDefault = totalCost - defaultTotalCost;
    const weightVsDefault = (totalWeight || 0) - defaultTotalWeight;
    
    // ANALYZE THE ACTUAL CONFIGURATION - this is the key!
    const analysis = analyzeConfiguration(optionDetails, defaultOptionsResult, performanceSummary);
    
    console.log("=== CONFIGURATION ANALYSIS ===");
    console.log("Upgraded categories:", analysis.upgradedCategories);
    console.log("Downgraded categories:", analysis.downgradedCategories);
    console.log("Premium components:", analysis.premiumComponents.map(p => p.name));
    console.log("Engine:", analysis.engineName);
    console.log("Turbo:", analysis.turboName);
    console.log("Transmission:", analysis.transmissionName);
    console.log("Cost vs default:", costVsDefault);
    console.log("Optimization history:", optimizationHistory);
    
    // Parse optimization history for context (but don't rely on it exclusively)
    const allRequests = (optimizationHistory || []).join(' ').toLowerCase();
    const userAskedToMaximize: string[] = [];
    const userAskedToMinimizeCost = /minimize.*cost|minimizing.*cost|minimize.*everything|minimizing everything|while minimizing/i.test(allRequests);
    
    if (/safety/i.test(allRequests) && /maxim/i.test(allRequests)) userAskedToMaximize.push('Safety');
    if (/comfort/i.test(allRequests) && /maxim/i.test(allRequests)) userAskedToMaximize.push('Comfort');
    if (/power/i.test(allRequests) && /maxim/i.test(allRequests)) userAskedToMaximize.push('Power');
    if (/hauling/i.test(allRequests) && /maxim/i.test(allRequests)) userAskedToMaximize.push('Hauling');
    if (/economy/i.test(allRequests) && /maxim/i.test(allRequests)) userAskedToMaximize.push('Economy');
    if (/durability/i.test(allRequests) && /maxim/i.test(allRequests)) userAskedToMaximize.push('Durability');
    
    // Build comprehensive prompt with ACTUAL configuration data
    const prompt = `Write a 2-sentence marketing description for this truck configuration. Be SPECIFIC about what makes it unique.

MODEL: ${modelName}
BASE: ${baseIntro}

=== ACTUAL CONFIGURATION ANALYSIS ===

PERFORMANCE PRIORITIES (categories with high scores):
${analysis.upgradedCategories.length > 0 ? `- Upgraded categories: ${analysis.upgradedCategories.join(', ')}` : '- No major category upgrades'}

COST OPTIMIZATION:
- Total cost vs default: ${costVsDefault >= 0 ? '+$' + costVsDefault.toLocaleString() : 'SAVES $' + Math.abs(costVsDefault).toLocaleString()}
${costVsDefault < 0 ? '- This configuration achieves SIGNIFICANT COST SAVINGS' : ''}

KEY COMPONENTS INSTALLED:
${analysis.engineName ? `- ENGINE: ${analysis.engineName}` : ''}
${analysis.turboName ? `- TURBOCHARGER: ${analysis.turboName}` : ''}
${analysis.transmissionName ? `- TRANSMISSION: ${analysis.transmissionName}` : ''}

OTHER PREMIUM UPGRADES:
${analysis.premiumComponents.filter(p => p.type !== 'engine' && p.type !== 'turbocharger' && p.type !== 'transmission').map(p => `- ${p.name} (${p.type})`).join('\n') || '- None'}

${optimizationHistory && optimizationHistory.length > 0 ? `
USER'S STATED GOALS:
${optimizationHistory.map((h: string) => `"${h}"`).join(', ')}
` : ''}

=== REQUIREMENTS FOR YOUR DESCRIPTION ===

Your description MUST mention:
${analysis.upgradedCategories.length > 0 || userAskedToMaximize.length > 0 ? `1. Performance focus: ${[...new Set([...analysis.upgradedCategories, ...userAskedToMaximize])].join(' and ')}` : '1. Key performance characteristics'}
${costVsDefault < 0 ? `2. The cost savings of $${Math.abs(costVsDefault).toLocaleString()}` : costVsDefault > 5000 ? `2. Premium build (+$${costVsDefault.toLocaleString()})` : ''}
${analysis.engineName ? `3. The engine by name: "${analysis.engineName}"` : ''}
${analysis.turboName ? `4. The turbocharger: "${analysis.turboName}"` : ''}
${analysis.premiumComponents.length > 2 ? `5. That multiple powertrain components were upgraded for compatibility` : ''}

EXAMPLE FORMAT:
Optimized for [priorities] while saving $X, this ${modelName.split(' ')[0]} features the [Engine Name] engine with [Turbo] turbocharger and upgraded [other components] for maximum capability.

Write exactly 2 sentences. Be specific, mention component names, and don't be generic. Do NOT wrap your response in quotes.`;

    try {
      const aiDescription = await callCortexComplete(prompt);
      if (aiDescription && aiDescription.length > 30) {
        console.log("AI generated description:", aiDescription);
        const cleaned = aiDescription.trim().replace(/^["']|["']$/g, '');
        return NextResponse.json({ description: cleaned, isCortexGenerated: true });
      }
    } catch (aiError) {
      console.error("Cortex Complete failed, using fallback:", aiError);
    }
    
    // INTELLIGENT FALLBACK - build description from actual analysis
    let description = baseIntro;
    const parts: string[] = [];
    
    // Mention upgraded categories
    const priorityCategories = [...new Set([...analysis.upgradedCategories, ...userAskedToMaximize])];
    if (priorityCategories.length > 0) {
      parts.push(`optimized for ${priorityCategories.join(' and ').toLowerCase()}`);
    }
    
    // Mention cost savings
    if (costVsDefault < 0) {
      parts.push(`saving $${Math.abs(costVsDefault).toLocaleString()}`);
    }
    
    // Mention key components
    const componentParts: string[] = [];
    if (analysis.engineName) componentParts.push(`the ${analysis.engineName} engine`);
    if (analysis.turboName) componentParts.push(`${analysis.turboName} turbocharger`);
    if (analysis.transmissionName) componentParts.push(`${analysis.transmissionName} transmission`);
    
    if (componentParts.length > 0) {
      parts.push(`featuring ${componentParts.join(', ')}`);
    }
    
    if (parts.length > 0) {
      description += ` This build is ${parts.join(', ')}.`;
    } else {
      description += " This balanced configuration offers a mix of performance and value.";
    }
    
    return NextResponse.json({ description, isCortexGenerated: true });
  } catch (error) {
    console.error("Error generating description:", error);
    return NextResponse.json({ 
      description: "Custom truck configuration optimized for your needs.",
      isCortexGenerated: false 
    });
  }
}
