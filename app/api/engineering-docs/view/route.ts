import { NextRequest, NextResponse } from "next/server";
import { query, getFullTableName, getDatabase, getSchema } from "@/lib/snowflake";

export async function GET(request: NextRequest): Promise<Response> {
  const docId = request.nextUrl.searchParams.get("docId");
  
  if (!docId) {
    return NextResponse.json({ error: "No docId provided" }, { status: 400 });
  }
  
  try {
    const docs = await query<{ DOC_PATH: string; DOC_TITLE: string }>(`
      SELECT DISTINCT DOC_PATH, DOC_TITLE 
      FROM ${getFullTableName('ENGINEERING_DOCS_CHUNKED')} 
      WHERE DOC_ID = '${docId.replace(/'/g, "''")}'
      LIMIT 1
    `);
    
    if (docs.length === 0) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    
    const { DOC_PATH, DOC_TITLE } = docs[0];
    
    // Extract filename from path like '@BOM.BOM4.ENGINEERING_DOCS_STAGE/filename.pdf'
    const filename = DOC_PATH.split('/').pop() || '';
    const stageRef = `@${getDatabase()}.${getSchema()}.ENGINEERING_DOCS_STAGE`;
    
    // Generate presigned URL - syntax: GET_PRESIGNED_URL(stage, filename, expiration_seconds)
    const presignedResult = await query<{ URL: string }>(`
      SELECT GET_PRESIGNED_URL('${stageRef}', '${filename}', 3600) as URL
    `);
    
    if (presignedResult.length > 0 && presignedResult[0].URL) {
      return NextResponse.json({ 
        url: presignedResult[0].URL,
        title: DOC_TITLE
      });
    }
    
    return NextResponse.json({ error: "Failed to generate document URL" }, { status: 500 });
  } catch (error) {
    console.error("View doc error:", error);
    return NextResponse.json({ error: "Failed to retrieve document" }, { status: 500 });
  }
}
