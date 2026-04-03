import { NextResponse } from "next/server";
import { query, getFullTableName } from "@/lib/snowflake";

interface ChatMessage {
  CHAT_ID: string;
  SESSION_ID: string;
  MODEL_ID: string;
  CONFIG_ID: string | null;
  MESSAGE_ROLE: string;
  MESSAGE_CONTENT: string;
  OPTIMIZATION_APPLIED: boolean;
  CREATED_AT: string;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");
    const configId = searchParams.get("configId");
    
    if (!sessionId && !configId) {
      return NextResponse.json({ error: "sessionId or configId required" }, { status: 400 });
    }
    
    let messages: ChatMessage[];
    
    if (configId) {
      messages = await query<ChatMessage>(`
        SELECT CHAT_ID, SESSION_ID, MODEL_ID, CONFIG_ID, MESSAGE_ROLE, MESSAGE_CONTENT, 
               OPTIMIZATION_APPLIED, CREATED_AT
        FROM ${getFullTableName('CHAT_HISTORY')}
        WHERE CONFIG_ID = '${configId}'
        ORDER BY CREATED_AT ASC
      `);
    } else {
      messages = await query<ChatMessage>(`
        SELECT CHAT_ID, SESSION_ID, MODEL_ID, CONFIG_ID, MESSAGE_ROLE, MESSAGE_CONTENT, 
               OPTIMIZATION_APPLIED, CREATED_AT
        FROM ${getFullTableName('CHAT_HISTORY')}
        WHERE SESSION_ID = '${sessionId}'
        ORDER BY CREATED_AT ASC
      `);
    }
    
    const optimizationRequests = messages
      .filter(m => m.MESSAGE_ROLE === 'user' && m.OPTIMIZATION_APPLIED)
      .map(m => m.MESSAGE_CONTENT);
    
    return NextResponse.json({ 
      messages,
      optimizationRequests
    });
  } catch (error) {
    console.error("Error fetching chat history:", error);
    return NextResponse.json({ error: "Failed to fetch chat history" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { sessionId, modelId, role, content, optimizationApplied } = await request.json();
    
    if (!sessionId || !modelId || !role || !content) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    
    await query(`
      INSERT INTO ${getFullTableName('CHAT_HISTORY')} (SESSION_ID, MODEL_ID, MESSAGE_ROLE, MESSAGE_CONTENT, OPTIMIZATION_APPLIED)
      VALUES ('${sessionId}', '${modelId}', '${role}', '${content.replace(/'/g, "''")}', ${optimizationApplied || false})
    `);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error saving chat message:", error);
    return NextResponse.json({ error: "Failed to save chat message" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { sessionId, configId } = await request.json();
    
    if (!sessionId || !configId) {
      return NextResponse.json({ error: "sessionId and configId required" }, { status: 400 });
    }
    
    await query(`
      UPDATE ${getFullTableName('CHAT_HISTORY')}
      SET CONFIG_ID = '${configId}'
      WHERE SESSION_ID = '${sessionId}'
    `);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error linking chat history:", error);
    return NextResponse.json({ error: "Failed to link chat history" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");
    
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }
    
    await query(`
      DELETE FROM ${getFullTableName('CHAT_HISTORY')}
      WHERE SESSION_ID = '${sessionId}' AND CONFIG_ID IS NULL
    `);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting chat history:", error);
    return NextResponse.json({ error: "Failed to delete chat history" }, { status: 500 });
  }
}
