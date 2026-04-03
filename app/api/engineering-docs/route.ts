import { NextResponse } from "next/server";
import { query, getFullTableName, getSchema, getDatabase } from "@/lib/snowflake";

interface EngineeringDoc {
  docId: string;
  docTitle: string;
  docPath: string;
  chunkCount: number;
  linkedParts: Array<{ optionId: string; optionName: string; componentGroup: string }>;
  createdAt: string;
}

export async function GET(): Promise<Response> {
  try {
    const docs = await query<{
      DOC_ID: string;
      DOC_TITLE: string;
      DOC_PATH: string;
      CHUNK_COUNT: number;
      CREATED_AT: string;
      LINKED_PARTS: string | null;
    }>(`
      SELECT 
        DOC_ID,
        DOC_TITLE,
        DOC_PATH,
        COUNT(*) as CHUNK_COUNT,
        MIN(CREATED_AT) as CREATED_AT,
        MAX(LINKED_PARTS)::VARCHAR as LINKED_PARTS
      FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
      GROUP BY DOC_ID, DOC_TITLE, DOC_PATH
      ORDER BY 5 DESC
    `);

    const results: EngineeringDoc[] = [];

    for (const doc of docs) {
      let linkedParts: Array<{ optionId: string; optionName: string; componentGroup: string }> = [];
      
      if (doc.LINKED_PARTS) {
        try {
          linkedParts = JSON.parse(doc.LINKED_PARTS);
        } catch {
          linkedParts = await detectLinkedPartsForDoc(doc.DOC_TITLE);
        }
      } else {
        linkedParts = await detectLinkedPartsForDoc(doc.DOC_TITLE);
      }
      
      results.push({
        docId: doc.DOC_ID,
        docTitle: doc.DOC_TITLE,
        docPath: doc.DOC_PATH,
        chunkCount: doc.CHUNK_COUNT,
        linkedParts,
        createdAt: doc.CREATED_AT
      });
    }

    return NextResponse.json({ docs: results });
  } catch (error) {
    console.error("Error fetching engineering docs:", error);
    return NextResponse.json({ error: "Failed to fetch engineering docs" }, { status: 500 });
  }
}

async function detectLinkedPartsForDoc(docTitle: string): Promise<Array<{ optionId: string; optionName: string; componentGroup: string }>> {
  const linkedParts: Array<{ optionId: string; optionName: string; componentGroup: string }> = [];

  const hpMatch = docTitle.match(/(\d{3,4})\s*[_-]?\s*HP/i);
  if (hpMatch) {
    const hp = hpMatch[1];
    const results = await query<{ OPTION_ID: string; OPTION_NM: string; COMPONENT_GROUP: string }>(`
      SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP
      FROM ${getFullTableName('BOM_TBL')} 
      WHERE COMPONENT_GROUP = 'Power Rating' 
        AND OPTION_NM LIKE '%${hp}%HP%'
    `);
    for (const r of results) {
      linkedParts.push({ optionId: r.OPTION_ID, optionName: r.OPTION_NM, componentGroup: r.COMPONENT_GROUP });
    }
  }

  const axleMatch = docTitle.match(/(\d{1,2}),?(\d{3})\s*lb/i);
  if (axleMatch) {
    const weight = axleMatch[1] + axleMatch[2];
    const formattedWeight = parseInt(weight).toLocaleString();
    const results = await query<{ OPTION_ID: string; OPTION_NM: string; COMPONENT_GROUP: string }>(`
      SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP
      FROM ${getFullTableName('BOM_TBL')} 
      WHERE COMPONENT_GROUP = 'Axle Rating' 
        AND (OPTION_NM LIKE '%${weight}%' OR OPTION_NM LIKE '%${formattedWeight}%')
    `);
    for (const r of results) {
      linkedParts.push({ optionId: r.OPTION_ID, optionName: r.OPTION_NM, componentGroup: r.COMPONENT_GROUP });
    }
  }

  return linkedParts;
}

export async function DELETE(request: Request): Promise<Response> {
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
      const { docId } = await request.json();
      
      if (!docId) {
        await sendResult({ success: false, error: "No docId provided" });
        return;
      }

      await sendProgress('lookup', 'active', 'Finding document...');
      
      // Get the doc path before deleting
      const docInfo = await query<{ DOC_PATH: string; DOC_TITLE: string }>(`
        SELECT DISTINCT DOC_PATH, DOC_TITLE
        FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
        WHERE DOC_ID = '${docId.replace(/'/g, "''")}'
        LIMIT 1
      `);
      
      if (!docInfo.length) {
        await sendProgress('lookup', 'error', 'Document not found');
        await sendResult({ success: false, error: "Document not found" });
        return;
      }
      
      const docPath = docInfo[0].DOC_PATH;
      const docTitle = docInfo[0].DOC_TITLE;
      await sendProgress('lookup', 'done', docTitle);

      // Step 1: Delete from chunked table - delete by both DOC_ID and DOC_PATH to clean up any orphans
      await sendProgress('delete_chunks', 'active', 'Removing indexed chunks...');
      
      // First delete by docId
      await query(`
        DELETE FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
        WHERE DOC_ID = '${docId.replace(/'/g, "''")}'
      `);
      
      // Also delete any orphans with the same filename (different docIds from failed uploads)
      const filename = docPath.split('/').pop();
      if (filename) {
        await query(`
          DELETE FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')}
          WHERE DOC_PATH LIKE '%${filename.replace(/'/g, "''")}'
        `);
      }
      
      await sendProgress('delete_chunks', 'done');

      // Step 2: Remove PDF from stage
      await sendProgress('delete_stage', 'active', 'Removing PDF from stage...');
      try {
        // Extract filename from path like '@BOM.BOM3.ENGINEERING_DOCS_STAGE/filename.pdf'
        const filename = docPath.split('/').pop();
        if (filename) {
          await query(`REMOVE @${getDatabase()}.${getSchema()}.ENGINEERING_DOCS_STAGE/${filename}`);
        }
        await sendProgress('delete_stage', 'done');
      } catch (stageError) {
        console.warn("Stage file removal warning:", stageError);
        await sendProgress('delete_stage', 'done', 'File may have been already removed');
      }

      // Step 3: Refresh search service
      await sendProgress('refresh_search', 'active', 'Re-indexing search service...');
      try {
        await query(`ALTER CORTEX SEARCH SERVICE ${getDatabase()}.${getSchema()}.ENGINEERING_DOCS_SEARCH REFRESH`);
        await sendProgress('refresh_search', 'done');
      } catch (refreshError) {
        console.warn("Search refresh warning:", refreshError);
        await sendProgress('refresh_search', 'done', 'Auto-refresh scheduled');
      }

      await sendResult({ success: true, deletedDocId: docId, docTitle });
    } catch (error) {
      console.error("Error deleting engineering doc:", error);
      await sendResult({ 
        success: false, 
        error: "Failed to delete engineering doc",
        details: error instanceof Error ? error.message : "Unknown error"
      });
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
