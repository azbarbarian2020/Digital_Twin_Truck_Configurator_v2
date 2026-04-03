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
  IS_DEFAULT: boolean;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const configId = searchParams.get("configId");
  const modelId = searchParams.get("modelId");
  const optionsParam = searchParams.get("options");

  if (!modelId) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }

  try {
    const modelResult = await query<ModelInfo>(`
      SELECT MODEL_ID, MODEL_NM, TRUCK_DESCRIPTION, BASE_MSRP, BASE_WEIGHT_LBS
      FROM ${getFullTableName('MODEL_TBL')}
      WHERE MODEL_ID = '${modelId}'
    `);
    const model = modelResult[0];

    if (!model) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }

    const allOptions = await query<BOMOption & { IS_DEFAULT: boolean }>(`
      SELECT b.OPTION_ID, b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP, b.OPTION_NM,
             b.DESCRIPTION, b.COST_USD, b.WEIGHT_LBS, b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE,
             t.IS_DEFAULT
      FROM ${getFullTableName('BOM_TBL')} b
      INNER JOIN ${getFullTableName('TRUCK_OPTIONS')} t ON b.OPTION_ID = t.OPTION_ID
      WHERE t.MODEL_ID = '${modelId}'
      ORDER BY b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP, b.COST_USD
    `);

    const defaultOptionIds = allOptions
      .filter(o => o.IS_DEFAULT)
      .map(o => o.OPTION_ID);

    let selectedOptionIds: string[] = [];
    
    if (optionsParam) {
      selectedOptionIds = JSON.parse(optionsParam);
    } else if (configId) {
      const configResult = await query<{ CONFIG_OPTIONS: string[] }>(`
        SELECT CONFIG_OPTIONS
        FROM ${getFullTableName('SAVED_CONFIGS')}
        WHERE CONFIG_ID = '${configId}'
      `);
      if (configResult[0]) {
        selectedOptionIds = configResult[0].CONFIG_OPTIONS;
      }
    }

    const bomHierarchy = buildDetailedBOM(allOptions, selectedOptionIds, defaultOptionIds);

    return NextResponse.json({
      model,
      bomHierarchy,
      selectedOptionIds,
      defaultOptionIds,
      allOptions
    });
  } catch (error) {
    console.error("Error generating report data:", error);
    return NextResponse.json({ error: "Failed to generate report" }, { status: 500 });
  }
}

interface BOMItem {
  optionId: string;
  optionName: string;
  description: string;
  cost: number;
  weight: number;
  performanceCategory: string;
  performanceScore: number;
  status: "base" | "default" | "upgraded" | "downgraded";
  isSelected: boolean;
}

interface ComponentGroup {
  name: string;
  items: BOMItem[];
  selectedItem: BOMItem | null;
  totalCost: number;
  totalWeight: number;
}

interface Subsystem {
  name: string;
  componentGroups: ComponentGroup[];
  totalCost: number;
  totalWeight: number;
}

interface System {
  name: string;
  subsystems: Subsystem[];
  totalCost: number;
  totalWeight: number;
}

function buildDetailedBOM(
  allOptions: (BOMOption & { IS_DEFAULT: boolean })[],
  selectedOptionIds: string[],
  defaultOptionIds: string[]
): System[] {
  const systems: Record<string, System> = {};

  const componentGroupSelections = new Map<string, string>();
  const componentGroupDefaults = new Map<string, BOMOption & { IS_DEFAULT: boolean }>();
  
  for (const opt of allOptions) {
    const cgKey = `${opt.SYSTEM_NM}|${opt.SUBSYSTEM_NM}|${opt.COMPONENT_GROUP}`;
    
    if (opt.IS_DEFAULT) {
      componentGroupDefaults.set(cgKey, opt);
    }
    
    if (selectedOptionIds.includes(opt.OPTION_ID)) {
      componentGroupSelections.set(cgKey, opt.OPTION_ID);
    } else if (!componentGroupSelections.has(cgKey) && opt.IS_DEFAULT) {
      componentGroupSelections.set(cgKey, opt.OPTION_ID);
    }
  }

  for (const opt of allOptions) {
    const cgKey = `${opt.SYSTEM_NM}|${opt.SUBSYSTEM_NM}|${opt.COMPONENT_GROUP}`;
    const activeOptionId = componentGroupSelections.get(cgKey);
    const isActive = opt.OPTION_ID === activeOptionId;
    const isDefault = defaultOptionIds.includes(opt.OPTION_ID);
    const isExplicitlySelected = selectedOptionIds.includes(opt.OPTION_ID);
    
    let status: BOMItem["status"] = "base";
    if (isActive) {
      if (isDefault) {
        status = "default";
      } else if (isExplicitlySelected) {
        const defaultOpt = componentGroupDefaults.get(cgKey);
        if (defaultOpt) {
          if (opt.COST_USD > defaultOpt.COST_USD) {
            status = "upgraded";
          } else {
            status = "downgraded";
          }
        } else {
          status = "upgraded";
        }
      }
    } else if (isDefault && !isActive) {
      status = "base";
    }

    const bomItem: BOMItem = {
      optionId: opt.OPTION_ID,
      optionName: opt.OPTION_NM,
      description: opt.DESCRIPTION,
      cost: opt.COST_USD,
      weight: opt.WEIGHT_LBS,
      performanceCategory: opt.PERFORMANCE_CATEGORY,
      performanceScore: opt.PERFORMANCE_SCORE,
      status,
      isSelected: isActive
    };

    if (!systems[opt.SYSTEM_NM]) {
      systems[opt.SYSTEM_NM] = {
        name: opt.SYSTEM_NM,
        subsystems: [],
        totalCost: 0,
        totalWeight: 0
      };
    }

    let subsystem = systems[opt.SYSTEM_NM].subsystems.find(s => s.name === opt.SUBSYSTEM_NM);
    if (!subsystem) {
      subsystem = {
        name: opt.SUBSYSTEM_NM,
        componentGroups: [],
        totalCost: 0,
        totalWeight: 0
      };
      systems[opt.SYSTEM_NM].subsystems.push(subsystem);
    }

    let componentGroup = subsystem.componentGroups.find(c => c.name === opt.COMPONENT_GROUP);
    if (!componentGroup) {
      componentGroup = {
        name: opt.COMPONENT_GROUP,
        items: [],
        selectedItem: null,
        totalCost: 0,
        totalWeight: 0
      };
      subsystem.componentGroups.push(componentGroup);
    }

    componentGroup.items.push(bomItem);
    if (isActive) {
      componentGroup.selectedItem = bomItem;
      componentGroup.totalCost = bomItem.cost;
      componentGroup.totalWeight = bomItem.weight;
    }
  }

  for (const system of Object.values(systems)) {
    for (const subsystem of system.subsystems) {
      subsystem.totalCost = subsystem.componentGroups.reduce((sum, cg) => sum + cg.totalCost, 0);
      subsystem.totalWeight = subsystem.componentGroups.reduce((sum, cg) => sum + cg.totalWeight, 0);
    }
    system.totalCost = system.subsystems.reduce((sum, ss) => sum + ss.totalCost, 0);
    system.totalWeight = system.subsystems.reduce((sum, ss) => sum + ss.totalWeight, 0);
  }

  return Object.values(systems).sort((a, b) => a.name.localeCompare(b.name));
}
