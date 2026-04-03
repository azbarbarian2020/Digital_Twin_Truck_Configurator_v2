import { NextResponse } from "next/server";
import { query } from "@/lib/snowflake";

interface OptionDetail {
  optionId: string;
  optionName: string;
  system: string;
  subsystem: string;
  cost: number;
  performanceCategory: string;
  performanceScore: number;
  description: string;
}

interface ModelInfo {
  modelName: string;
  modelDescription: string;
  baseMsrp: number;
}

interface PerformanceDelta {
  category: string;
  baseline: number;
  current: number;
  change: number;
}

interface ConfigContext {
  totalCost: number;
  baseMsrp: number;
  optionsCost: number;
  addedOptions: OptionDetail[];
  removedOptions: OptionDetail[];
  performanceDeltas: PerformanceDelta[];
}

interface CortexResult {
  DESCRIPTION: string;
}

export async function POST(request: Request) {
  try {
    const { modelInfo, configContext } = await request.json();
    
    const prompt = buildSmartPrompt(modelInfo, configContext);
    const description = await callCortexComplete(prompt);
    
    return NextResponse.json({ description });
  } catch (error) {
    console.error("Generate description error:", error);
    return NextResponse.json({ 
      error: `Failed to generate description: ${(error as Error).message}` 
    }, { status: 500 });
  }
}

function buildSmartPrompt(modelInfo: ModelInfo, context: ConfigContext): string {
  const { addedOptions, removedOptions, performanceDeltas, totalCost, baseMsrp, optionsCost } = context;
  
  const costDiff = optionsCost;
  const costSavings = costDiff < 0;
  const costIncrease = costDiff > 0;
  
  const addedSystems = [...new Set(addedOptions.map(o => o.system))];
  const removedSystems = [...new Set(removedOptions.map(o => o.system))];
  
  const improvedCategories = performanceDeltas
    .filter(d => d.change > 0)
    .sort((a, b) => b.change - a.change);
  const reducedCategories = performanceDeltas
    .filter(d => d.change < 0)
    .sort((a, b) => a.change - b.change);
  
  let configCharacter = "";
  if (addedOptions.length === 0 && removedOptions.length === 0) {
    configCharacter = "STOCK/BASE configuration with all factory default options.";
  } else if (addedOptions.length === 0 && removedOptions.length > 0) {
    configCharacter = "STRIPPED-DOWN/BUDGET build that removes standard equipment for cost savings.";
  } else if (costSavings && improvedCategories.some(c => c.category.toLowerCase().includes('economy'))) {
    configCharacter = "ECONOMY-FOCUSED build optimized for fuel efficiency and lower operating costs.";
  } else if (improvedCategories.length >= 3 && addedOptions.length > 5) {
    configCharacter = "FULLY-LOADED premium build with comprehensive upgrades across multiple systems.";
  } else if (improvedCategories.length === 1) {
    configCharacter = `${improvedCategories[0].category.toUpperCase()}-FOCUSED build prioritizing ${improvedCategories[0].category.toLowerCase()} performance.`;
  } else if (costSavings && removedOptions.length > addedOptions.length) {
    configCharacter = "VALUE-OPTIMIZED build that strategically removes options to reduce cost.";
  } else {
    configCharacter = "CUSTOM build with selective modifications tailored to specific needs.";
  }

  const addedSummary = addedOptions.length > 0 
    ? `ADDED ${addedOptions.length} options: ${addedOptions.slice(0, 4).map(o => o.optionName).join(", ")}${addedOptions.length > 4 ? `, +${addedOptions.length - 4} more` : ""}`
    : "No options added beyond defaults.";
  
  const removedSummary = removedOptions.length > 0
    ? `REMOVED ${removedOptions.length} default options: ${removedOptions.slice(0, 3).map(o => o.optionName).join(", ")}${removedOptions.length > 3 ? `, +${removedOptions.length - 3} more` : ""}`
    : "All default options retained.";

  const perfSummary = [];
  if (improvedCategories.length > 0) {
    perfSummary.push(`IMPROVED: ${improvedCategories.map(c => `${c.category} (+${Math.round(c.change * 20)}%)`).join(", ")}`);
  }
  if (reducedCategories.length > 0) {
    perfSummary.push(`REDUCED: ${reducedCategories.map(c => `${c.category} (${Math.round(c.change * 20)}%)`).join(", ")}`);
  }

  const costSummary = costSavings 
    ? `SAVES $${Math.abs(costDiff).toLocaleString()} compared to default configuration`
    : costIncrease 
      ? `ADDS $${costDiff.toLocaleString()} in upgrades over default`
      : "Same cost as default configuration";

  return `Write a compelling 2-3 sentence marketing description for this custom truck configuration.

BASE MODEL: ${modelInfo.modelName}
MODEL PURPOSE: ${modelInfo.modelDescription}

CONFIGURATION CHARACTER: ${configCharacter}

MODIFICATIONS FROM DEFAULT:
${addedSummary}
${removedSummary}

${removedSystems.length > 0 ? `SYSTEMS STRIPPED/DOWNGRADED: ${removedSystems.join(", ")}` : ""}
${addedSystems.length > 0 ? `SYSTEMS ENHANCED: ${addedSystems.join(", ")}` : ""}

PERFORMANCE IMPACT:
${perfSummary.length > 0 ? perfSummary.join("\n") : "No significant performance changes."}

COST IMPACT: ${costSummary}
Total: $${totalCost.toLocaleString()} (Base: $${baseMsrp.toLocaleString()})

Requirements:
- Describe what makes THIS configuration special based on the modifications
- Reference what was traded off (removed) to gain the benefits (added)
- Mention the target use case or buyer for this build
- Keep under 200 characters
- No quotes, just the description text
- Sound like a professional sales pitch that understands the configuration's character`;
}

async function callCortexComplete(prompt: string): Promise<string> {
  const escapedPrompt = prompt.replace(/'/g, "''");
  const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('mistral-large2', '${escapedPrompt}') AS DESCRIPTION`;
  
  const results = await query<CortexResult>(sql);
  
  if (results.length > 0 && results[0].DESCRIPTION) {
    let result = results[0].DESCRIPTION;
    if (result.startsWith('"') && result.endsWith('"')) {
      result = result.slice(1, -1);
    }
    return result.trim();
  }
  
  throw new Error("No result from Cortex COMPLETE");
}
