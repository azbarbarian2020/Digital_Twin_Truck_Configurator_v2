import { NextResponse } from "next/server";
import { query, getFullTableName } from "@/lib/snowflake";

interface BOMOption {
  OPTION_ID: string;
  SYSTEM_NM: string;
  SUBSYSTEM_NM: string;
  COMPONENT_GROUP: string;
  OPTION_NM: string;
  DESCRIPTION: string;
  COST_USD: number;
  WEIGHT_LBS: number;
  PERFORMANCE_CATEGORY: string;
  PERFORMANCE_SCORE: number;
  SOURCE_COUNTRY: string;
  SPECS: Record<string, unknown> | null;
}

interface ModelOption {
  MODEL_ID: string;
  OPTION_ID: string;
  IS_DEFAULT: boolean;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const modelId = searchParams.get("modelId");

  if (!modelId) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }

  try {
    const options = await query<BOMOption & { IS_DEFAULT: boolean }>(`
      SELECT b.OPTION_ID, b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP, b.OPTION_NM,
             b.DESCRIPTION, b.COST_USD, b.WEIGHT_LBS, b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE,
             b.SOURCE_COUNTRY, b.SPECS, t.IS_DEFAULT
      FROM ${getFullTableName('BOM_TBL')} b
      INNER JOIN ${getFullTableName('TRUCK_OPTIONS')} t ON b.OPTION_ID = t.OPTION_ID
      WHERE t.MODEL_ID = '${modelId}'
      ORDER BY b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP, b.COST_USD
    `);

    const modelOptions: ModelOption[] = options.map(o => ({
      MODEL_ID: modelId,
      OPTION_ID: o.OPTION_ID,
      IS_DEFAULT: o.IS_DEFAULT
    }));

    const hierarchy = buildHierarchy(options);
    
    return NextResponse.json({ 
      options, 
      modelOptions,
      hierarchy 
    });
  } catch (error) {
    console.error("Error fetching options:", error);
    return NextResponse.json({ error: "Failed to fetch options" }, { status: 500 });
  }
}

function buildHierarchy(options: BOMOption[]) {
  const systems: Record<string, {
    subsystems: Record<string, {
      componentGroups: Record<string, BOMOption[]>
    }>
  }> = {};

  for (const opt of options) {
    if (!systems[opt.SYSTEM_NM]) {
      systems[opt.SYSTEM_NM] = { subsystems: {} };
    }
    if (!systems[opt.SYSTEM_NM].subsystems[opt.SUBSYSTEM_NM]) {
      systems[opt.SYSTEM_NM].subsystems[opt.SUBSYSTEM_NM] = { componentGroups: {} };
    }
    if (!systems[opt.SYSTEM_NM].subsystems[opt.SUBSYSTEM_NM].componentGroups[opt.COMPONENT_GROUP]) {
      systems[opt.SYSTEM_NM].subsystems[opt.SUBSYSTEM_NM].componentGroups[opt.COMPONENT_GROUP] = [];
    }
    systems[opt.SYSTEM_NM].subsystems[opt.SUBSYSTEM_NM].componentGroups[opt.COMPONENT_GROUP].push(opt);
  }

  return systems;
}
