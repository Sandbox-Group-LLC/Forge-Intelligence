import { sql } from './client';

// Semantic similarity search via pgvector
export async function semanticSearch(
  clientId: string,
  queryEmbedding: number[],
  limit = 10
): Promise<unknown[]> {
  const rows = await sql(
    `SELECT id, raw_content, metadata, performance_outcome,
            1 - (embedding <=> $1::vector) AS similarity
     FROM memories
     WHERE client_id = $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [JSON.stringify(queryEmbedding), clientId, limit]
  );
  return rows;
}

// Write a new memory after content is generated
export async function writeMemory(
  clientId: string,
  rawContent: string,
  embedding: number[],
  metadata: Record<string, unknown>
) {
  return await sql(
    `INSERT INTO memories (client_id, raw_content, embedding, metadata)
     VALUES ($1, $2, $3::vector, $4)
     RETURNING id`,
    [clientId, rawContent, JSON.stringify(embedding), JSON.stringify(metadata)]
  );
}

// Brain-First: get top patterns + mistakes before agent acts
export async function getBrainContext(clientId: string) {
  const [patterns, mistakes] = await Promise.all([
    sql(`SELECT * FROM patterns WHERE client_id = $1 AND confidence_score >= 0.6
         ORDER BY recency_weight DESC, success_rate DESC LIMIT 20`, [clientId]),
    sql(`SELECT * FROM mistakes WHERE client_id = $1 AND severity IN ('HIGH', 'CRITICAL')
         ORDER BY created_at DESC LIMIT 10`, [clientId])
  ]);
  return { patterns, mistakes };
}
