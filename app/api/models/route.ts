import { NextResponse } from "next/server";
import { query, getFullTableName } from "@/lib/snowflake";

interface Model {
  MODEL_ID: string;
  MODEL_NM: string;
  TRUCK_DESCRIPTION: string;
  BASE_MSRP: number;
  BASE_WEIGHT_LBS: number;
  MAX_PAYLOAD_LBS: number;
  MAX_TOWING_LBS: number;
  SLEEPER_AVAILABLE: boolean;
}

export async function GET() {
  try {
    const models = await query<Model>(`
      SELECT MODEL_ID, MODEL_NM, TRUCK_DESCRIPTION, BASE_MSRP, 
             BASE_WEIGHT_LBS, MAX_PAYLOAD_LBS, MAX_TOWING_LBS, SLEEPER_AVAILABLE
      FROM ${getFullTableName('MODEL_TBL')}
      ORDER BY BASE_MSRP
    `);
    return NextResponse.json(models);
  } catch (error) {
    console.error("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
