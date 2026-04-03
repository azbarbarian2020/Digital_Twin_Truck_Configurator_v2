import { NextResponse } from "next/server";
import { query, getFullTableName } from "@/lib/snowflake";

function escapeSqlString(str: string): string {
  if (!str) return '';
  return str.replace(/'/g, "''");
}

interface SavedConfig {
  CONFIG_ID: string;
  CONFIG_NAME: string;
  MODEL_ID: string;
  CREATED_BY: string;
  TOTAL_COST_USD: number;
  TOTAL_WEIGHT_LBS: number;
  PERFORMANCE_SUMMARY: object;
  CONFIG_OPTIONS: string[] | string;
  NOTES: string;
  IS_VALIDATED: boolean;
}

export async function GET() {
  try {
    const configs = await query<SavedConfig>(`
      SELECT CONFIG_ID, CONFIG_NAME, MODEL_ID, CREATED_BY,
             TOTAL_COST_USD, TOTAL_WEIGHT_LBS, 
             PERFORMANCE_SUMMARY, CONFIG_OPTIONS, NOTES, IS_VALIDATED
      FROM ${getFullTableName('SAVED_CONFIGS')}
      ORDER BY CREATED_AT DESC
    `);
    
    // Convert CONFIG_OPTIONS from string to array if needed
    const processedConfigs = configs.map(config => ({
      ...config,
      CONFIG_OPTIONS: typeof config.CONFIG_OPTIONS === 'string' 
        ? config.CONFIG_OPTIONS.split(',')
        : config.CONFIG_OPTIONS
    }));
    
    return NextResponse.json(processedConfigs);
  } catch (error) {
    console.error("Error fetching configs:", error);
    return NextResponse.json({ error: "Failed to fetch configs" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { configName, modelId, selectedOptions, totalCost, totalWeight, performanceSummary, notes, createdBy, isValidated } = body;
    
    const configId = `CFG-${Date.now()}`;
    const optionsJson = JSON.stringify(selectedOptions);
    const perfJson = JSON.stringify(performanceSummary);
    
    const safeConfigName = escapeSqlString(configName);
    const safeNotes = escapeSqlString(notes || '');
    const safeCreatedBy = escapeSqlString(createdBy || 'User');
    
    await query(`
      INSERT INTO ${getFullTableName('SAVED_CONFIGS')} 
        (CONFIG_ID, CONFIG_NAME, MODEL_ID, CREATED_BY, TOTAL_COST_USD, 
         TOTAL_WEIGHT_LBS, PERFORMANCE_SUMMARY, CONFIG_OPTIONS, NOTES, IS_VALIDATED)
      SELECT '${configId}', '${safeConfigName}', '${modelId}', '${safeCreatedBy}',
             ${totalCost}, ${totalWeight}, 
             PARSE_JSON('${perfJson}'), PARSE_JSON('${optionsJson}'), '${safeNotes}', ${isValidated ? 'TRUE' : 'FALSE'}
    `);
    
    return NextResponse.json({ success: true, configId });
  } catch (error) {
    console.error("Error saving config:", error);
    return NextResponse.json({ error: "Failed to save config" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { configId, configName, notes } = body;
    
    if (!configId || !configName) {
      return NextResponse.json({ error: "Config ID and name are required" }, { status: 400 });
    }
    
    const safeConfigName = escapeSqlString(configName);
    const safeNotes = escapeSqlString(notes || '');
    
    await query(`
      UPDATE ${getFullTableName('SAVED_CONFIGS')} 
      SET CONFIG_NAME = '${safeConfigName}', 
          NOTES = '${safeNotes}',
          UPDATED_AT = CURRENT_TIMESTAMP()
      WHERE CONFIG_ID = '${configId}'
    `);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating config:", error);
    return NextResponse.json({ error: "Failed to update config" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const configId = searchParams.get('configId');
    
    if (!configId) {
      return NextResponse.json({ error: "Config ID is required" }, { status: 400 });
    }
    
    await query(`
      DELETE FROM ${getFullTableName('SAVED_CONFIGS')} 
      WHERE CONFIG_ID = '${configId}'
    `);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting config:", error);
    return NextResponse.json({ error: "Failed to delete config" }, { status: 500 });
  }
}
