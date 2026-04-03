import { NextResponse } from "next/server";
import { query, getFullTableName, getSemanticView, getCortexAgent, getAuthHeaders } from "@/lib/snowflake";

interface Recommendation {
  optionId: string;
  optionName: string;
  componentGroup: string;
  cost: number;
  reason: string;
  action: 'upgrade' | 'downgrade' | 'add';
  performanceCategory?: string;
}

interface ApplyAction {
  type: 'optimize' | 'replace';
  optionIds: string[];
  summary: string;
}

interface ChatResponse {
  response: string;
  recommendations?: Recommendation[];
  canApply?: boolean;
  applyAction?: ApplyAction;
}

const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || "";

interface OptionDetail {
  optionId: string;
  optionName: string;
  cost: number;
  weight?: number;
  system: string;
  subsystem: string;
  componentGroup: string;
  performanceCategory?: string;
  performanceScore?: number;
}

interface ModelInfo {
  modelId: string;
  modelName: string;
  baseMsrp: number;
  baseWeight?: number;
}

interface BOMOption {
  OPTION_ID: string;
  OPTION_NM: string;
  COMPONENT_GROUP: string;
  COST_USD: number;
  PERFORMANCE_CATEGORY: string;
  PERFORMANCE_SCORE: number;
  SYSTEM_NM: string;
  SUBSYSTEM_NM: string;
  OPTION_TIER: string;
}

interface CortexCompleteResponse {
  choices: Array<{
    messages: string;
  }>;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { message, modelId, selectedOptions, modelInfo } = body;
    
    const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
    const backendResponse = await fetch(`${backendUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, modelId, selectedOptions, modelInfo })
    });
    
    if (backendResponse.ok) {
      const data = await backendResponse.json();
      return NextResponse.json(data);
    }
    
    console.log("Backend unavailable, using local handler");
    const result = await handleChatRequest(message, modelId, selectedOptions || [], modelInfo);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Chat error:", error);
    return NextResponse.json({ 
      response: `Error: ${(error as Error).message}. Please try again.` 
    }, { status: 500 });
  }
}

function classifyQuery(message: string): 'optimization' | 'simple' | 'complex' | 'document_inventory' {
  const normalizedMsg = message.toLowerCase();
  
  if (/what.*objects.*have.*(spec|doc|requirement)|which.*(objects|options|components).*have.*(doc|spec)|list.*all.*doc|all.*engineering.*doc|what.*doc.*exist/i.test(normalizedMsg)) {
    return 'document_inventory';
  }
  
  if (/maximize|minimize|optimize|best for|cheapest|improve|upgrade|recommend|configure.*base|base.*config|no options|lowest cost/i.test(normalizedMsg)) {
    return 'optimization';
  }
  
  if (/what|which|show|list|compare|price|cost|weight|tell me about/i.test(normalizedMsg)) {
    return 'simple';
  }
  
  return 'complex';
}

async function handleChatRequest(
  message: string, 
  modelId: string, 
  selectedOptions: OptionDetail[],
  modelInfo?: ModelInfo
): Promise<ChatResponse> {
  const startTime = Date.now();
  console.log("=== CHAT REQUEST ===");
  console.log("Message:", message);
  console.log("Model:", modelId);
  
  const queryType = classifyQuery(message);
  console.log("Query type:", queryType);
  
  try {
    if (queryType === 'document_inventory') {
      const result = await handleDocumentInventoryQuery();
      console.log("Document inventory query completed in", Date.now() - startTime, "ms");
      return result;
    }
    
    if (queryType === 'optimization') {
      const result = await handleOptimizationWithCortexAgent(message, modelId, selectedOptions, modelInfo);
      console.log("Cortex Agent optimization completed in", Date.now() - startTime, "ms");
      return result;
    }
    
    const enhancedMessage = buildEnhancedMessage(message, modelId, selectedOptions, modelInfo);
    const agentResult = await callCortexAgent(enhancedMessage);
    console.log("Agent completed in", Date.now() - startTime, "ms");
    
    const recommendations = extractRecommendationsFromResponse(agentResult.response, selectedOptions);
    
    return { 
      response: agentResult.response,
      recommendations 
    };
  } catch (error) {
    console.error("Chat error:", error);
    return { response: `Error processing request: ${(error as Error).message}` };
  }
}

async function handleOptimizationWithCortexAgent(
  message: string,
  modelId: string,
  selectedOptions: OptionDetail[],
  modelInfo?: ModelInfo
): Promise<ChatResponse> {
  console.log("=== CORTEX AGENT OPTIMIZATION ===");
  
  const lowerMessage = message.toLowerCase();
  const isBaseRequest = /\b(base|no options|minimum|cheapest|lowest)\b/.test(lowerMessage) && 
                        (/\bwithout\b|\bno\b|\bonly\b|\bjust\b/.test(lowerMessage) || /\bbase\s*(price|cost|config)?\b/.test(lowerMessage));
  
  if (isBaseRequest) {
    return await handleBaseConfigurationRequest(modelId, modelInfo);
  }
  
  const allOptions = await query<BOMOption & { WEIGHT_LBS: number }>(`
    SELECT b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS,
           b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE, b.SYSTEM_NM, b.SUBSYSTEM_NM, b.OPTION_TIER
    FROM ${getFullTableName('BOM_TBL')} b
    INNER JOIN ${getFullTableName('TRUCK_OPTIONS')} t ON b.OPTION_ID = t.OPTION_ID
    WHERE t.MODEL_ID = '${modelId}'
    ORDER BY b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP, b.COST_USD
  `);
  
  console.log(`Found ${allOptions.length} available options for model ${modelId}`);

  const lowerMsg = message.toLowerCase();
  const wantsMinimizeCost = /minimize.*cost|minimizing.*cost|cheapest|lowest cost|budget|reduce cost|save money|minimizing all other/i.test(lowerMsg);
  const wantsMinimizeWeight = /minimize.*weight|minimizing.*weight|lightest|lowest weight|reduce weight/i.test(lowerMsg);
  const wantsMinimize = wantsMinimizeCost || wantsMinimizeWeight || /minimize|minimizing/i.test(lowerMsg);
  const wantsMaximize = /maximize|maximizing|best|highest|top|optimal/i.test(lowerMsg);
  
  const categoriesToMaximize: string[] = [];
  if (/comfort/i.test(lowerMsg)) categoriesToMaximize.push('Comfort');
  if (/safety/i.test(lowerMsg)) categoriesToMaximize.push('Safety');
  if (/power/i.test(lowerMsg)) categoriesToMaximize.push('Power');
  if (/economy|fuel/i.test(lowerMsg)) categoriesToMaximize.push('Economy');
  if (/durability/i.test(lowerMsg)) categoriesToMaximize.push('Durability');
  if (/emissions/i.test(lowerMsg)) categoriesToMaximize.push('Emissions');
  if (/hauling/i.test(lowerMsg)) categoriesToMaximize.push('Hauling');
  
  const minimizeTarget = wantsMinimizeWeight ? 'WEIGHT_LBS' : 'COST_USD';
  const minimizeLabel = wantsMinimizeWeight ? 'weight' : 'cost';
  
  console.log("Intent:", wantsMinimize && !wantsMaximize ? `minimize ${minimizeLabel} only` : wantsMaximize && wantsMinimize ? `maximize + minimize ${minimizeLabel}` : "maximize only");
  console.log("Categories to maximize:", categoriesToMaximize);
  
  let analystQuery: string;
  if (wantsMinimize && !wantsMaximize) {
    analystQuery = `Select the option with lowest ${minimizeTarget} for each component group where MODEL_ID = '${modelId}'. Return one option per component group with OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, PERFORMANCE_CATEGORY, PERFORMANCE_SCORE.`;
  } else if (wantsMaximize && wantsMinimize && categoriesToMaximize.length > 0) {
    const categoryList = categoriesToMaximize.map(c => `'${c}'`).join(', ');
    analystQuery = `For MODEL_ID = '${modelId}': For component groups where PERFORMANCE_CATEGORY IN (${categoryList}), select the option with highest PERFORMANCE_SCORE. For all other component groups, select the option with lowest ${minimizeTarget}. Return one option per component group with OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, PERFORMANCE_CATEGORY, PERFORMANCE_SCORE.`;
  } else if (wantsMaximize && categoriesToMaximize.length > 0) {
    const categoryList = categoriesToMaximize.map(c => `'${c}'`).join(', ');
    analystQuery = `For MODEL_ID = '${modelId}', select options where PERFORMANCE_CATEGORY IN (${categoryList}) with the highest PERFORMANCE_SCORE for each component group. Return OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, PERFORMANCE_CATEGORY, PERFORMANCE_SCORE.`;
  } else {
    analystQuery = `For MODEL_ID = '${modelId}', ${message}. Return OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, PERFORMANCE_CATEGORY, PERFORMANCE_SCORE.`;
  }
  
  console.log("Calling Cortex Analyst with:", analystQuery);
  
  const analystResult = await callCortexAnalyst(analystQuery);
  
  if (!analystResult.sql) {
    return {
      response: analystResult.response || "Could not generate optimization. Please try rephrasing your request.",
      recommendations: []
    };
  }
  
  console.log("Analyst generated SQL:", analystResult.sql.substring(0, 200));
  
  let optimizedOptions: {
    OPTION_ID: string;
    OPTION_NM: string;
    COMPONENT_GROUP: string;
    COST_USD: number;
    PERFORMANCE_CATEGORY: string;
    PERFORMANCE_SCORE: number;
  }[];
  
  try {
    optimizedOptions = await query<{
      OPTION_ID: string;
      OPTION_NM: string;
      COMPONENT_GROUP: string;
      COST_USD: number;
      PERFORMANCE_CATEGORY: string;
      PERFORMANCE_SCORE: number;
    }>(analystResult.sql);
  } catch (sqlError) {
    console.error("SQL execution error:", sqlError);
    return {
      response: "I generated an optimization query but couldn't execute it. Please try a simpler request.",
      recommendations: []
    };
  }
  
  console.log(`Analyst returned ${optimizedOptions.length} optimized options`);
  
  const bestByGroup: Record<string, typeof optimizedOptions[0]> = {};
  for (const opt of optimizedOptions) {
    const existing = bestByGroup[opt.COMPONENT_GROUP];
    if (!existing || 
        opt.PERFORMANCE_SCORE > existing.PERFORMANCE_SCORE ||
        (opt.PERFORMANCE_SCORE === existing.PERFORMANCE_SCORE && opt.COST_USD < existing.COST_USD)) {
      bestByGroup[opt.COMPONENT_GROUP] = opt;
    }
  }
  const deduplicatedOptions = Object.values(bestByGroup);
  console.log(`After deduplication: ${deduplicatedOptions.length} options`);
  
  const recommendations: Recommendation[] = deduplicatedOptions.map(opt => {
    const isUpgrade = opt.COST_USD > 0 || opt.PERFORMANCE_SCORE > 2;
    return {
      optionId: opt.OPTION_ID,
      optionName: opt.OPTION_NM,
      componentGroup: opt.COMPONENT_GROUP,
      cost: opt.COST_USD,
      reason: opt.COST_USD === 0 ? 'Base option ($0)' : `${opt.PERFORMANCE_CATEGORY} (score: ${opt.PERFORMANCE_SCORE})`,
      action: isUpgrade ? 'upgrade' : 'downgrade',
      performanceCategory: opt.PERFORMANCE_CATEGORY
    };
  });
  
  const upgrades = recommendations.filter(r => r.action === 'upgrade');
  const downgrades = recommendations.filter(r => r.action === 'downgrade');
  
  let responseText = `**AI-Optimized Configuration**\n\n`;
  responseText += `*Powered by Cortex Analyst*\n\n`;
  
  if (upgrades.length > 0) {
    responseText += `**UPGRADES:**\n`;
    for (const r of upgrades) {
      responseText += `- [${r.optionId}] ${r.optionName} - $${r.cost} - ${r.reason}\n`;
    }
    responseText += '\n';
  }
  
  if (downgrades.length > 0) {
    responseText += `**BASE OPTIONS ($0):**\n`;
    for (const r of downgrades) {
      responseText += `- [${r.optionId}] ${r.optionName}\n`;
    }
  }
  
  const totalCost = recommendations.reduce((sum, r) => sum + r.cost, 0);
  responseText += `\n**Total options cost: $${totalCost.toLocaleString()}**`;
  
  console.log(`Cortex Analyst optimization: ${upgrades.length} upgrades, ${downgrades.length} downgrades`);
  
  return {
    response: responseText,
    recommendations,
    canApply: recommendations.length > 0,
    applyAction: recommendations.length > 0 ? {
      type: 'optimize',
      optionIds: recommendations.map(r => r.optionId),
      summary: `${recommendations.length} optimized options`
    } : undefined
  };
}

async function handleBaseConfigurationRequest(
  modelId: string,
  modelInfo?: ModelInfo
): Promise<ChatResponse> {
  console.log("=== BASE CONFIGURATION REQUEST ===");
  
  const baseOptions = await query<{
    OPTION_ID: string;
    OPTION_NM: string;
    COMPONENT_GROUP: string;
    COST_USD: number;
    PERFORMANCE_CATEGORY: string;
  }>(`
    WITH base_per_group AS (
      SELECT 
        b.COMPONENT_GROUP,
        MIN(b.OPTION_ID) as OPTION_ID
      FROM ${getFullTableName('BOM_TBL')} b
      INNER JOIN ${getFullTableName('TRUCK_OPTIONS')} t ON b.OPTION_ID = t.OPTION_ID
      WHERE t.MODEL_ID = '${modelId}' AND b.COST_USD = 0
      GROUP BY b.COMPONENT_GROUP
    )
    SELECT b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.PERFORMANCE_CATEGORY
    FROM base_per_group bg
    JOIN ${getFullTableName('BOM_TBL')} b ON bg.OPTION_ID = b.OPTION_ID
    ORDER BY b.COMPONENT_GROUP
  `);
  
  console.log(`Found ${baseOptions.length} base ($0) options for model ${modelId}`);
  
  const baseMsrp = modelInfo?.baseMsrp || 0;
  
  const recommendations: Recommendation[] = baseOptions.map(opt => ({
    optionId: opt.OPTION_ID,
    optionName: opt.OPTION_NM,
    componentGroup: opt.COMPONENT_GROUP,
    cost: opt.COST_USD,
    reason: 'Base configuration - $0 option',
    action: 'downgrade' as const,
    performanceCategory: opt.PERFORMANCE_CATEGORY
  }));
  
  let responseText = `**Base Configuration**\n\n`;
  responseText += `*Configuring to base price of $${baseMsrp.toLocaleString()} with all $0 options.*\n\n`;
  responseText += `**${baseOptions.length} components set to base options:**\n`;
  
  const groupedBySystem: Record<string, typeof baseOptions> = {};
  for (const opt of baseOptions) {
    const system = opt.COMPONENT_GROUP.split(' ')[0] || 'Other';
    if (!groupedBySystem[system]) groupedBySystem[system] = [];
    groupedBySystem[system].push(opt);
  }
  
  for (const [, opts] of Object.entries(groupedBySystem).slice(0, 5)) {
    for (const opt of opts.slice(0, 3)) {
      responseText += `- ${opt.OPTION_NM}\n`;
    }
    if (opts.length > 3) responseText += `  ...and ${opts.length - 3} more\n`;
  }
  
  responseText += `\n**Total: $${baseMsrp.toLocaleString()}** (base MSRP only, no add-ons)\n`;
  responseText += `\n*Click Apply to configure to base.*`;
  
  return {
    response: responseText,
    recommendations,
    canApply: true,
    applyAction: {
      type: 'replace',
      optionIds: baseOptions.map(o => o.OPTION_ID),
      summary: `Base configuration - $${baseMsrp.toLocaleString()}`
    }
  };
}

async function handleDocumentInventoryQuery(): Promise<ChatResponse> {
  console.log("=== DOCUMENT INVENTORY QUERY ===");
  
  const docs = await query<{
    OPTION_ID: string;
    OPTION_NM: string;
    COMPONENT_GROUP: string;
    SYSTEM_NM: string;
    SUBSYSTEM_NM: string;
    DOC_TITLE: string;
  }>(`
    WITH flattened AS (
      SELECT DISTINCT 
        p.value:optionId::STRING as OPTION_ID,
        p.value:optionName::STRING as OPTION_NM,
        p.value:componentGroup::STRING as COMPONENT_GROUP,
        d.DOC_TITLE
      FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')} d,
      LATERAL FLATTEN(input => d.LINKED_PARTS) p
    )
    SELECT 
      f.OPTION_ID,
      f.OPTION_NM,
      f.COMPONENT_GROUP,
      b.SYSTEM_NM,
      b.SUBSYSTEM_NM,
      f.DOC_TITLE
    FROM flattened f
    LEFT JOIN ${getFullTableName('BOM_TBL')} b ON f.OPTION_ID = b.OPTION_ID
    ORDER BY b.SYSTEM_NM, b.SUBSYSTEM_NM, f.COMPONENT_GROUP, f.OPTION_NM
  `);
  
  console.log(`Found ${docs.length} options with engineering documents`);
  
  if (docs.length === 0) {
    return {
      response: "No engineering specification documents are currently in the system. Documents need to be uploaded via the Engineering Documents panel."
    };
  }
  
  const bySystem: Record<string, Record<string, Record<string, typeof docs>>> = {};
  for (const doc of docs) {
    const sys = doc.SYSTEM_NM || 'Unknown';
    const sub = doc.SUBSYSTEM_NM || 'Unknown';
    const grp = doc.COMPONENT_GROUP || 'Unknown';
    if (!bySystem[sys]) bySystem[sys] = {};
    if (!bySystem[sys][sub]) bySystem[sys][sub] = {};
    if (!bySystem[sys][sub][grp]) bySystem[sys][sub][grp] = [];
    bySystem[sys][sub][grp].push(doc);
  }
  
  let responseText = `**Engineering Documents Inventory**\n\n`;
  responseText += `Found **${docs.length} BOM option(s)** with engineering specification documents:\n\n`;
  
  for (const [system, subsystems] of Object.entries(bySystem)) {
    responseText += `**${system}**\n`;
    for (const [subsystem, groups] of Object.entries(subsystems)) {
      responseText += `  - ${subsystem}\n`;
      for (const [group, groupDocs] of Object.entries(groups)) {
        responseText += `      - ${group}\n`;
        for (const doc of groupDocs) {
          responseText += `          - [${doc.OPTION_ID}] ${doc.OPTION_NM}\n`;
          responseText += `            Document: *${doc.DOC_TITLE}*\n`;
        }
      }
    }
    responseText += '\n';
  }
  
  responseText += `---\n*These documents define engineering requirements that are validated against BOM specifications during configuration.*`;
  
  return { response: responseText };
}

function buildEnhancedMessage(
  message: string,
  modelId: string,
  selectedOptions: OptionDetail[],
  modelInfo?: ModelInfo
): string {
  const totalCost = selectedOptions.reduce((sum, opt) => sum + opt.cost, 0);
  
  const optionsList = selectedOptions.slice(0, 10).map(opt => 
    `${opt.componentGroup}: ${opt.optionName} ($${opt.cost})`
  ).join(', ');
  
  let context = `[Model: ${modelInfo?.modelName || modelId}]`;
  if (selectedOptions.length > 0) {
    context += ` [Current add-ons total: $${totalCost}]`;
    context += ` [Selected: ${optionsList}]`;
  }
  
  return `${context}\n\nUser question: ${message}`;
}

async function callCortexAgent(message: string): Promise<{ response: string }> {
  const headers = getAuthHeaders();
  headers["Accept"] = "text/event-stream";
  const url = `https://${SNOWFLAKE_HOST}/api/v2/databases/${getCortexAgent()}:run`;
  
  const requestBody = {
    messages: [{ 
      role: "user", 
      content: [{ type: "text", text: message }] 
    }]
  };
  
  console.log("Calling Cortex Agent with JWT auth...");
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Agent error:", response.status, errorText);
      throw new Error(`Agent error: ${response.status}`);
    }
    
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }
    
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.role === "assistant" && data.content) {
              for (const item of data.content) {
                if (item.type === "text") {
                  fullText = item.text || "";
                }
              }
            }
            if (data.text && !data.content_index) {
              fullText += data.text;
            }
          } catch { }
        }
      }
    }
    
    return { response: fullText || "No response from agent" };
  } catch (error) {
    clearTimeout(timeout);
    if ((error as Error).name === 'AbortError') {
      throw new Error("Request timed out. Please try a simpler query.");
    }
    throw error;
  }
}

async function callCortexAnalyst(question: string): Promise<{ response: string; sql?: string }> {
  const headers = getAuthHeaders();
  const url = `https://${SNOWFLAKE_HOST}/api/v2/cortex/analyst/message`;
  const semanticView = getSemanticView();
  
  const requestBody = {
    messages: [{ 
      role: "user", 
      content: [{ type: "text", text: question }] 
    }],
    semantic_view: semanticView
  };
  
  console.log("Calling Cortex Analyst with semantic view:", semanticView);
  console.log("Question:", question);
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Analyst error:", response.status, errorText);
      return { response: `I couldn't process that optimization request. The Cortex Analyst service returned an error. Please try rephrasing your request or try a simpler query.` };
    }
    
    const data = await response.json();
    
    let sql: string | undefined;
    let responseText = "";
    
    if (data.message?.content) {
      for (const item of data.message.content) {
        if (item.type === "sql") {
          sql = item.statement;
        } else if (item.type === "text") {
          responseText = item.text || "";
        }
      }
    }
    
    console.log("Analyst response - SQL:", sql ? "Generated" : "None", "Text:", responseText.substring(0, 100));
    
    return { response: responseText, sql };
  } catch (error) {
    console.error("Analyst call failed:", error);
    return { response: `I couldn't connect to the optimization service. Please try again in a moment.` };
  }
}

function extractRecommendationsFromResponse(
  response: string,
  selectedOptions: OptionDetail[],
  allOptions?: (BOMOption & { WEIGHT_LBS: number })[]
): Recommendation[] {
  const currentByGroup: Record<string, OptionDetail> = {};
  for (const opt of selectedOptions) {
    currentByGroup[opt.componentGroup] = opt;
  }
  
  const optionLookup: Record<string, BOMOption & { WEIGHT_LBS: number }> = {};
  if (allOptions) {
    for (const opt of allOptions) {
      optionLookup[opt.OPTION_ID] = opt;
    }
  }
  
  const recommendations: Recommendation[] = [];
  const foundIds = new Set<string>();
  
  const upgradeSection = response.indexOf('UPGRADE');
  const downgradeSection = response.indexOf('DOWNGRADE');
  
  const validOptionIds = new Set(Object.keys(optionLookup));
  const numberPattern = /\b(\d+)\b/g;
  
  let match;
  while ((match = numberPattern.exec(response)) !== null) {
    const optionId = match[1];
    if (!foundIds.has(optionId) && validOptionIds.has(optionId)) {
      const optionData = optionLookup[optionId];
      if (optionData) {
        const matchPosition = match.index;
        const isInUpgradeSection = upgradeSection !== -1 && downgradeSection !== -1 
          ? matchPosition < downgradeSection 
          : (optionData.PERFORMANCE_CATEGORY === 'Safety' || optionData.PERFORMANCE_CATEGORY === 'Comfort');
        
        const action: 'upgrade' | 'downgrade' | 'add' = isInUpgradeSection ? 'upgrade' : 'downgrade';
        const reason = isInUpgradeSection ? 'Higher performance' : 'Cost savings';
        
        recommendations.push({
          optionId,
          optionName: optionData.OPTION_NM,
          componentGroup: optionData.COMPONENT_GROUP,
          cost: optionData.COST_USD,
          reason,
          action,
          performanceCategory: optionData.PERFORMANCE_CATEGORY
        });
        foundIds.add(optionId);
      }
    }
  }
  
  return recommendations;
}
