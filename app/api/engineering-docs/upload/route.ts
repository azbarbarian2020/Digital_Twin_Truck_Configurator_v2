import { NextResponse } from "next/server";
import { query, getFullTableName, getSchema, getDatabase, putFile } from "@/lib/snowflake";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

function getStageRef(): string {
  return `@${getDatabase()}.${getSchema()}.ENGINEERING_DOCS_STAGE`;
}

export async function POST(request: Request): Promise<Response> {
  let tempFilePath: string | null = null;
  
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  
  const sendProgress = async (step: string, status: 'pending' | 'active' | 'done' | 'error', message?: string) => {
    const data = JSON.stringify({ step, status, message });
    await writer.write(encoder.encode(`data: ${data}\n\n`));
  };
  
  const sendResult = async (result: object) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'result', ...result })}\n\n`));
    await writer.close();
  };

  (async () => {
    try {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      const targetOptionId = formData.get("targetOptionId") as string | null;
      
      if (!file) {
        await sendResult({ success: false, error: "No file provided" });
        return;
      }
      
      if (!file.name.toLowerCase().endsWith(".pdf")) {
        await sendResult({ success: false, error: "Only PDF files are supported" });
        return;
      }

      await sendProgress('upload', 'active', 'Uploading to Snowflake stage...');
      
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      
      const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const stageFileName = sanitizedName;
      tempFilePath = join(tmpdir(), stageFileName);
      await writeFile(tempFilePath, buffer);
      
      try {
        await putFile(tempFilePath, getStageRef());
      } catch (uploadError) {
        console.error("Stage upload failed:", uploadError);
        await sendProgress('upload', 'error', 'Failed to upload to stage');
        await sendResult({ success: false, error: "Failed to upload file to Snowflake stage" });
        return;
      }
      
      await sendProgress('upload', 'done');
      await sendProgress('extract', 'active', 'Extracting text with PARSE_DOCUMENT...');

      const extractResult = await query<{ FULL_TEXT: string }>(`
        SELECT SNOWFLAKE.CORTEX.PARSE_DOCUMENT(
          '${getStageRef()}',
          '${stageFileName}',
          {'mode': 'LAYOUT'}
        ):content::VARCHAR AS FULL_TEXT
      `);
      
      if (!extractResult.length || !extractResult[0].FULL_TEXT) {
        await sendProgress('extract', 'error', 'Failed to extract text');
        await sendResult({ success: false, error: "Failed to extract text from PDF" });
        return;
      }
      
      const fullText = extractResult[0].FULL_TEXT;
      await sendProgress('extract', 'done');
      
      await sendProgress('chunk', 'active', 'Creating searchable chunks...');
      
      const docTitle = extractDocTitle(fullText, sanitizedName);
      const docId = `DOC-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`.toUpperCase();
      
      // If targetOptionId provided, look up part details for LINKED_PARTS
      let linkedPartsJson: string | null = null;
      if (targetOptionId) {
        const optionInfo = await query<{ OPTION_NM: string; COMPONENT_GROUP: string }>(`
          SELECT OPTION_NM, COMPONENT_GROUP 
          FROM ${getFullTableName('BOM_TBL')} 
          WHERE OPTION_ID = ${targetOptionId}
        `);
        if (optionInfo.length > 0) {
          linkedPartsJson = JSON.stringify([{
            optionId: targetOptionId,
            optionName: optionInfo[0].OPTION_NM,
            componentGroup: optionInfo[0].COMPONENT_GROUP
          }]);
        }
      }
      
      const chunks = chunkText(fullText, 1500, 200);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunkTextContent = chunks[i].replace(/'/g, "''");
        const linkedPartsExpr = linkedPartsJson ? `PARSE_JSON('${linkedPartsJson.replace(/'/g, "''")}')` : 'NULL';
        await query(`
          INSERT INTO ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
            (DOC_ID, DOC_TITLE, DOC_PATH, CHUNK_INDEX, CHUNK_TEXT, LINKED_PARTS)
          SELECT 
            '${docId}', '${docTitle.replace(/'/g, "''")}', 
            '${getStageRef()}/${stageFileName}', 
            ${i + 1}, '${chunkTextContent}', ${linkedPartsExpr}
        `);
      }
      
      await sendProgress('chunk', 'done', `Created ${chunks.length} chunks`);
      
      await sendProgress('search', 'active', 'Refreshing search service...');
      
      try {
        await query(`ALTER CORTEX SEARCH SERVICE ${getDatabase()}.${getSchema()}.ENGINEERING_DOCS_SEARCH REFRESH`);
        await sendProgress('search', 'done');
      } catch (refreshError) {
        console.warn("Search refresh warning:", refreshError);
        await sendProgress('search', 'done', 'Auto-refresh scheduled');
      }
      
      // Detect what this doc is about (for display purposes)
      await sendProgress('analyze', 'active', 'Analyzing document scope...');
      const docScope = await analyzeDocScope(fullText, docTitle);
      await sendProgress('analyze', 'done', docScope.summary);
      
      await sendResult({
        success: true,
        docId,
        docTitle,
        chunkCount: chunks.length,
        scope: docScope
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error("Upload error:", errorMessage);
      console.error("Stack:", errorStack);
      await sendResult({ 
        success: false,
        error: errorMessage,
        details: errorStack
      });
    } finally {
      if (tempFilePath) {
        try {
          await unlink(tempFilePath);
        } catch {}
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

function extractDocTitle(text: string, filename: string): string {
  const lines = text.split('\n').filter(l => l.trim());
  
  for (const line of lines.slice(0, 10)) {
    const clean = line.replace(/[#*_]/g, '').trim();
    if (clean.length > 10 && clean.length < 100) {
      if (/specification|requirement|compatibility|engineering|application/i.test(clean)) {
        return clean;
      }
    }
  }
  
  // Look for descriptive patterns
  const patterns = [
    /high.power.*engine/i,
    /heavy.duty.*application/i,
    /(\d{3,4})\s*HP.*requirement/i,
    /(\d{1,2},?\d{3})\s*lb.*specification/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }
  
  return filename.replace(/\.pdf$/i, '').replace(/_/g, ' ');
}

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n/);
  
  let currentChunk = "";
  
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    
    if (currentChunk.length + trimmed.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      const words = currentChunk.split(' ');
      const overlapWords = words.slice(-Math.floor(overlap / 5));
      currentChunk = overlapWords.join(' ') + '\n\n' + trimmed;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + trimmed;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks.length > 0 ? chunks : [text.substring(0, chunkSize)];
}

interface DocScope {
  summary: string;
  triggerConditions: string[];
  componentRequirements: string[];
}

async function analyzeDocScope(text: string, docTitle: string): Promise<DocScope> {
  const prompt = `Analyze this engineering specification document and summarize what it covers.

DOCUMENT TITLE: ${docTitle}

DOCUMENT TEXT (first 2000 chars):
${text.substring(0, 2000)}

Return a JSON object with:
1. summary: A brief one-line description of what this doc specifies (e.g., "Requirements for 500+ HP engine applications")
2. triggerConditions: What configuration triggers these requirements (e.g., ["engines 500+ HP", "heavy-duty applications"])
3. componentRequirements: What component types have requirements (e.g., ["Radiator", "Turbocharger", "Transmission"])

Return ONLY the JSON object.`;

  try {
    const results = await query<{ RESPONSE: string }>(`
      SELECT SNOWFLAKE.CORTEX.COMPLETE('mistral-large2', '${prompt.replace(/'/g, "''")}') AS RESPONSE
    `);
    
    if (!results.length) {
      return { summary: docTitle, triggerConditions: [], componentRequirements: [] };
    }
    
    const response = results[0].RESPONSE.trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { summary: docTitle, triggerConditions: [], componentRequirements: [] };
  } catch (error) {
    console.error("Failed to analyze doc scope:", error);
    return { summary: docTitle, triggerConditions: [], componentRequirements: [] };
  }
}
