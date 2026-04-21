/**
 * OpenAPI 3.1 spec generator for universal-memory.
 *
 * Generated programmatically so the spec cannot drift from the runtime.
 * Every shape defined here is sourced from server/mem0-mcp-http.mjs — if you
 * change a route's request/response shape there, update the spec here and
 * confirm server/test/openapi.test.mjs still passes.
 *
 * Served at: GET /openapi.yaml  (see mem0-mcp-http.mjs)
 * Downstream consumer: ChatGPT Custom GPT Actions (Phase D Task D2).
 *
 * Exports:
 *   - generateOpenAPISpec(): string             -> YAML text (full spec)
 *   - generateCustomGPTActionsSpec(): string    -> YAML text (trimmed subset
 *     for ChatGPT Custom GPT Actions — only /api/search (POST), /api/state/{project},
 *     /api/add, /api/delete, /api/recent/{project}; no /mcp, no /health, no 5xx
 *     responses, schemas pruned to only those referenced by the 5 kept routes.)
 */

import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** Reference helper — shorter than writing `$ref` strings by hand */
function ref(name) {
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * Standard error response envelope returned by server on any 4xx/5xx path.
 * Shape sourced from server/mem0-mcp-http.mjs — every failing branch writes
 * `{ error: <string> }`. Some MCP tool paths also emit `{ ok: false, error }`
 * inside JSON-RPC results, but that happens in the `/mcp` success body
 * (status 200), not the HTTP error path, so this schema is HTTP-layer-only.
 */
const ERROR_RESPONSE = {
  description: 'Error response with a human-readable message',
  content: {
    'application/json': { schema: ref('ErrorResponse') },
  },
};

/** Re-usable 500 response — every route can throw and fall through to the
 *  top-level try/catch which writes `{ error: <message> }`. */
const RESP_500 = {
  500: {
    description: 'Unhandled server error',
    content: {
      'application/json': { schema: ref('ErrorResponse') },
    },
  },
};

// ---------------------------------------------------------------------------
// components.schemas
// ---------------------------------------------------------------------------

const SCHEMAS = {
  ErrorResponse: {
    type: 'object',
    description:
      'Error envelope returned on any non-2xx HTTP response. Always contains the `error` field. Some write-gated MCP tools additionally return `{ ok: false, error }` inside a 200 JSON-RPC body; that shape is represented by `McpWriteGatedResponse`.',
    properties: {
      error: { type: 'string', description: 'Human-readable error message' },
    },
    required: ['error'],
  },

  McpWriteGatedResponse: {
    type: 'object',
    description:
      'Returned inside MCP tool results when the server is in read-only mode (UM_MCP_WRITE_ENABLED != true).',
    properties: {
      ok: { type: 'boolean', enum: [false] },
      error: { type: 'string' },
    },
    required: ['ok', 'error'],
  },

  MemoryMetadata: {
    type: 'object',
    description:
      'Arbitrary metadata attached to a mem0 document. Fields follow UM vault frontmatter conventions. All fields are optional; callers may add custom keys.',
    additionalProperties: true,
    properties: {
      schema_version: { type: 'integer', description: 'UM metadata schema version (always 1 in v0.3)' },
      type: {
        type: 'string',
        description: 'Document type (e.g. session_summary, authored, state)',
      },
      id: {
        type: 'string',
        description: 'Stable document id — filename stem without .md. Must match ^[a-zA-Z0-9._-]+$.',
      },
      title: { type: 'string' },
      project: { type: 'string', description: 'Owning project slug (matches ^[a-zA-Z0-9._-]+$)' },
      status: {
        type: 'string',
        enum: ['current', 'superseded', 'deprecated', 'rejected'],
        description:
          'Document lifecycle state. Search excludes superseded/deprecated/rejected by default.',
      },
      valid_from: { type: 'string', format: 'date-time' },
      invalidated_at: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When set, the doc is filtered out of search by default.',
      },
      superseded_by: { type: 'string' },
      supersedes: { type: 'array', items: { type: 'string' } },
    },
  },

  MemoryResult: {
    type: 'object',
    description: 'A single memory record returned by search/list endpoints (full shape, ?full=1).',
    properties: {
      id: { type: 'string', description: 'mem0 UUID (not the metadata.id)' },
      memory: { type: 'string', description: 'The stored text' },
      score: {
        type: 'number',
        description:
          'Relevance score. When UM_TEMPORAL_DECAY=true this is the decayed score (original * exp(-age/halfLife)).',
      },
      metadata: ref('MemoryMetadata'),
      hash: { type: 'string' },
      created_at: { type: ['string', 'null'] },
      updated_at: { type: ['string', 'null'] },
      user_id: { type: 'string' },
    },
  },

  CompactMemoryResult: {
    type: 'object',
    description:
      'Compact memory record returned by default (without ?full=1) from search, list, and recent endpoints. Contains only the most commonly needed fields. Use ?full=1 to get the full MemoryResult shape.',
    required: ['id', 'title', 'snippet'],
    properties: {
      id: { type: 'string', description: 'mem0 UUID (not the metadata.id)' },
      title: { type: 'string', description: 'Document title from metadata.title' },
      snippet: {
        type: 'string',
        description: 'Short text excerpt from the stored memory body',
      },
      score: {
        type: 'number',
        description:
          'Optional relevance score (present on search results; absent on list/recent). When UM_TEMPORAL_DECAY=true this is the decayed score.',
      },
    },
  },

  CompactSearchResponse: {
    type: 'object',
    description: 'Default search/list/recent response (compact shape). Use ?full=1 for MemoryResult[].',
    required: ['results'],
    properties: {
      results: { type: 'array', items: ref('CompactMemoryResult') },
    },
  },

  SearchFilters: {
    type: 'object',
    description: 'Optional post-filters applied after mem0 recall.',
    additionalProperties: false,
    properties: {
      project: { type: 'string', description: 'Keep only results whose metadata.project matches' },
      type: { type: 'string', description: 'Keep only results whose metadata.type matches' },
    },
  },

  SearchRequest: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Semantic search query (non-empty)' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 5,
        description: 'Max results. Clamped to [1, 100]; default 5.',
      },
      include_superseded: {
        type: 'boolean',
        default: false,
        description:
          'If true, return results regardless of status/invalidated_at. Default false (exclude superseded/deprecated/rejected and anything with invalidated_at).',
      },
      filters: ref('SearchFilters'),
    },
  },

  SearchResponse: {
    type: 'object',
    description:
      'Default response shape for /api/search (compact). Add ?full=1 to get MemoryResult[] instead.',
    required: ['results'],
    properties: {
      results: { type: 'array', items: ref('CompactMemoryResult') },
    },
  },

  SearchResponseFull: {
    type: 'object',
    description: 'Full response shape for /api/search when ?full=1 is provided.',
    required: ['results'],
    properties: {
      results: { type: 'array', items: ref('MemoryResult') },
    },
  },

  AddRequest: {
    type: 'object',
    required: ['text'],
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: 'Raw text to extract facts from and store.' },
      metadata: ref('MemoryMetadata'),
    },
  },

  AddResponse: {
    type: 'object',
    description:
      'Raw mem0 add() return shape. `results` is the list of extracted/upserted atomic facts.',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            memory: { type: 'string' },
            event: { type: 'string', description: 'ADD | UPDATE | DELETE | NONE' },
          },
        },
      },
    },
  },

  ReindexRequest: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        description:
          'Vault-relative path to the markdown file to (re)index. Traversal outside the vault is rejected. state.md is never reindexed.',
      },
    },
  },

  ReindexResponse: {
    type: 'object',
    required: ['ok', 'path', 'id', 'indexed'],
    properties: {
      ok: { type: 'boolean', enum: [true] },
      path: { type: 'string' },
      id: { type: 'string', description: 'metadata.id that was indexed' },
      indexed: { type: 'boolean', enum: [true] },
    },
  },

  StateResponse: {
    type: 'object',
    required: ['ok', 'project'],
    properties: {
      ok: { type: 'boolean', enum: [true] },
      project: { type: 'string' },
      state: {
        oneOf: [
          {
            type: 'object',
            required: ['frontmatter', 'body'],
            properties: {
              frontmatter: { type: 'object', additionalProperties: true },
              body: { type: 'string' },
            },
          },
          { type: 'null' },
        ],
      },
      valid_from: {
        oneOf: [
          { type: 'string', format: 'date-time' },
          { type: 'null' },
        ],
      },
    },
  },

  DeleteRequest: {
    description:
      'Two shapes: A) `{ metadata: { id } }` to delete every mem0 entry whose metadata.id matches; B) `{ id }` to delete a single entry by mem0 UUID.',
    oneOf: [
      {
        type: 'object',
        title: 'DeleteByMetadataId',
        required: ['metadata'],
        additionalProperties: false,
        properties: {
          metadata: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', minLength: 1 } },
          },
        },
      },
      {
        type: 'object',
        title: 'DeleteByUuid',
        required: ['id'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, description: 'mem0 UUID' },
        },
      },
    ],
  },

  DeleteResponse: {
    type: 'object',
    required: ['ok', 'deleted', 'query'],
    properties: {
      ok: { type: 'boolean', enum: [true] },
      deleted: { type: 'integer', minimum: 0, description: 'Count of entries actually removed' },
      query: { type: 'string', description: 'Echo of the delete criterion, e.g. metadata.id=foo' },
    },
  },

  DeleteByUuidResponse: {
    type: 'object',
    required: ['deleted'],
    properties: {
      deleted: { type: 'string', description: 'The mem0 UUID that was deleted' },
    },
  },

  HealthResponse: {
    type: 'object',
    required: ['ok', 'memories'],
    properties: {
      ok: { type: 'boolean', enum: [true] },
      memories: { type: 'integer', minimum: 0, description: 'Count of memories for MEM0_USER_ID' },
    },
  },

  // ── MCP (JSON-RPC 2.0) ────────────────────────────────────────────────────

  JsonRpcRequest: {
    type: 'object',
    required: ['jsonrpc', 'method'],
    properties: {
      jsonrpc: { type: 'string', enum: ['2.0'] },
      id: {
        oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
        description: 'Correlation id. Omit for notifications.',
      },
      method: {
        type: 'string',
        description:
          'MCP method. Supported: initialize, notifications/initialized, tools/list, tools/call.',
      },
      params: { type: 'object', additionalProperties: true },
    },
  },

  JsonRpcResponse: {
    type: 'object',
    description: 'Standard JSON-RPC 2.0 response envelope. Either `result` or `error` is present.',
    required: ['jsonrpc'],
    properties: {
      jsonrpc: { type: 'string', enum: ['2.0'] },
      id: {
        oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
      },
      result: { type: 'object', additionalProperties: true },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'integer' },
          message: { type: 'string' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Path builders
// ---------------------------------------------------------------------------

function pathHealth() {
  return {
    get: {
      operationId: 'getHealth',
      summary: 'Liveness + memory count',
      description:
        'Returns `{ ok: true, memories: <count> }`. Used by container orchestrators and the MCP plugin auto-start hook.',
      responses: {
        200: {
          description: 'Server is healthy',
          content: {
            'application/json': { schema: ref('HealthResponse') },
          },
        },
        ...RESP_500,
      },
    },
  };
}

function pathSearch() {
  return {
    post: {
      operationId: 'searchMemories',
      summary: 'Semantic search',
      description:
        'Body form. Returns compact shape by default; add `?full=1` for full MemoryResult[]. Applies default status filter (excludes superseded/deprecated/rejected, and any doc with invalidated_at set) unless `include_superseded=true`. Optional `filters.project` / `filters.type` are applied after mem0 recall.',
      parameters: [
        {
          name: 'full',
          in: 'query',
          required: false,
          schema: { type: 'boolean', default: false },
          description: 'When true, return full MemoryResult[] instead of compact CompactMemoryResult[]',
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: ref('SearchRequest') },
        },
      },
      responses: {
        200: {
          description: 'Search succeeded. Default: compact CompactMemoryResult[]; with ?full=1: full MemoryResult[].',
          content: {
            'application/json': {
              schema: {
                oneOf: [ref('SearchResponse'), ref('SearchResponseFull')],
              },
            },
          },
        },
        400: {
          ...ERROR_RESPONSE,
          description: 'Missing or invalid `query`',
        },
        ...RESP_500,
      },
    },
    get: {
      operationId: 'searchMemoriesByQueryString',
      summary: 'Semantic search (query-string form)',
      description:
        'Mirror of POST /api/search. Accepts `q`, `limit`, `include_superseded`, `type`, `full` via query string. The query-string form does not support `filters.project`; use POST for that.',
      parameters: [
        {
          name: 'q',
          in: 'query',
          required: true,
          schema: { type: 'string', minLength: 1 },
          description: 'Semantic search query',
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 5 },
        },
        {
          name: 'include_superseded',
          in: 'query',
          required: false,
          schema: { type: 'boolean', default: false },
        },
        {
          name: 'type',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Post-filter by metadata.type',
        },
        {
          name: 'full',
          in: 'query',
          required: false,
          schema: { type: 'boolean', default: false },
          description: 'When true, return full MemoryResult[] instead of compact CompactMemoryResult[]',
        },
      ],
      responses: {
        200: {
          description: 'Search succeeded. Default: compact CompactMemoryResult[]; with ?full=1: full MemoryResult[].',
          content: {
            'application/json': {
              schema: {
                oneOf: [ref('SearchResponse'), ref('SearchResponseFull')],
              },
            },
          },
        },
        400: {
          ...ERROR_RESPONSE,
          description: 'Missing `q`',
        },
        ...RESP_500,
      },
    },
  };
}

function pathAdd() {
  return {
    post: {
      operationId: 'addMemory',
      summary: 'Extract facts and store via mem0',
      description:
        'Passes `text` through mem0\'s LLM fact extractor and persists the resulting atomic memories. Optional `metadata` is attached to every extracted fact.',
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: ref('AddRequest') },
        },
      },
      responses: {
        200: {
          description: 'Facts extracted and stored',
          content: { 'application/json': { schema: ref('AddResponse') } },
        },
        ...RESP_500,
      },
    },
  };
}

function pathList() {
  return {
    get: {
      operationId: 'listMemories',
      summary: 'List all memories for MEM0_USER_ID',
      description:
        'Returns the unfiltered list of every memory for the server\'s configured user. Returns compact shape by default; add `?full=1` for full MemoryResult[].',
      parameters: [
        {
          name: 'full',
          in: 'query',
          required: false,
          schema: { type: 'boolean', default: false },
          description: 'When true, return full MemoryResult[] instead of compact CompactMemoryResult[]',
        },
      ],
      responses: {
        200: {
          description: 'Memory list. Default: compact CompactMemoryResult[]; with ?full=1: full MemoryResult[].',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  ref('CompactSearchResponse'),
                  { type: 'array', items: ref('MemoryResult') },
                ],
              },
            },
          },
        },
        ...RESP_500,
      },
    },
  };
}

function pathReindex() {
  return {
    post: {
      operationId: 'reindexVaultFile',
      summary: '(Re)index a vault markdown file',
      description:
        'Reads `$VAULT/<path>`, parses frontmatter, deletes prior mem0 entries with matching metadata.id, and re-adds the document with `infer: false`. state.md files are rejected. Filename stem must match frontmatter.id.',
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: ref('ReindexRequest') },
        },
      },
      responses: {
        200: {
          description: 'File indexed',
          content: { 'application/json': { schema: ref('ReindexResponse') } },
        },
        400: {
          ...ERROR_RESPONSE,
          description:
            'Invalid JSON body, missing `path`, path traversal detected, missing required frontmatter fields, id/filename mismatch, or state.md reindex attempt',
        },
        404: {
          ...ERROR_RESPONSE,
          description: 'File not found in vault',
        },
        ...RESP_500,
      },
    },
  };
}

function pathState() {
  return {
    get: {
      operationId: 'getStateByProject',
      summary: 'Read state.md for a project',
      description:
        'Direct vault read of `$VAULT/state/<project>/state.md`. Does NOT hit mem0. When the file does not exist, returns `{ ok: true, project, state: null, valid_from: null }` with status 200 (not 404).',
      parameters: [
        {
          name: 'project',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[a-zA-Z0-9._-]+$' },
          description: 'Project slug. Must match ^[a-zA-Z0-9._-]+$.',
        },
      ],
      responses: {
        200: {
          description:
            'State file contents (or `state: null` when the file does not exist for this project)',
          content: { 'application/json': { schema: ref('StateResponse') } },
        },
        400: {
          ...ERROR_RESPONSE,
          description: 'Invalid project name',
        },
        ...RESP_500,
      },
    },
  };
}

function pathRecent() {
  return {
    get: {
      operationId: 'getRecentByProject',
      summary: 'Most-recent memories for a project',
      description:
        'Returns the N most-recently indexed memories for the given project slug. Returns compact shape by default; add `?full=1` for full MemoryResult[]. Results are sorted newest-first by updated_at.',
      parameters: [
        {
          name: 'project',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[a-zA-Z0-9._-]+$' },
          description: 'Project slug. Must match ^[a-zA-Z0-9._-]+$.',
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
          description: 'Max results to return. Clamped to [1, 100]; default 10.',
        },
        {
          name: 'full',
          in: 'query',
          required: false,
          schema: { type: 'boolean', default: false },
          description: 'When true, return full MemoryResult[] instead of compact CompactMemoryResult[]',
        },
      ],
      responses: {
        200: {
          description: 'Recent memories. Default: compact CompactMemoryResult[]; with ?full=1: full MemoryResult[].',
          content: {
            'application/json': {
              schema: {
                oneOf: [ref('CompactSearchResponse'), ref('SearchResponseFull')],
              },
            },
          },
        },
        400: {
          ...ERROR_RESPONSE,
          description: 'Invalid project name',
        },
        ...RESP_500,
      },
    },
  };
}

function pathDelete() {
  return {
    post: {
      operationId: 'deleteMemory',
      summary: 'Delete by metadata.id or mem0 UUID',
      description:
        'Two shapes — send exactly one of: `{ metadata: { id } }` to delete every entry matching metadata.id, or `{ id }` to delete one entry by mem0 UUID. Missing or both-present produces 400.',
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: ref('DeleteRequest') },
        },
      },
      responses: {
        200: {
          description: 'Delete completed (may have deleted 0 entries)',
          content: { 'application/json': { schema: ref('DeleteResponse') } },
        },
        400: {
          ...ERROR_RESPONSE,
          description: 'Invalid JSON, both shapes provided, or missing id',
        },
        ...RESP_500,
      },
    },
  };
}

function pathDeleteById() {
  return {
    delete: {
      operationId: 'deleteMemoryByUuid',
      summary: 'Delete a memory by mem0 UUID (URL parameter form)',
      description:
        'Alternative to POST /api/delete with `{ id }`. The `:id` URL segment is forwarded directly to mem0. Errors from mem0 (e.g. unknown UUID) surface as 500.',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', minLength: 1 },
          description: 'mem0 UUID',
        },
      ],
      responses: {
        200: {
          description: 'Entry deleted',
          content: { 'application/json': { schema: ref('DeleteByUuidResponse') } },
        },
        ...RESP_500,
      },
    },
  };
}

function pathMcp() {
  return {
    post: {
      operationId: 'mcpJsonRpc',
      summary: 'MCP (JSON-RPC 2.0) endpoint',
      description:
        'Accepts MCP protocol messages: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. The body of a notification (no `id`) is answered with an empty HTTP body. See docs/mcp-tools.md for the tool catalog.',
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: ref('JsonRpcRequest') },
        },
      },
      responses: {
        200: {
          description:
            'JSON-RPC response (or empty body for notifications that do not require a reply)',
          content: {
            'application/json': { schema: ref('JsonRpcResponse') },
          },
        },
        ...RESP_500,
      },
    },
  };
}

function pathOpenapi() {
  return {
    get: {
      operationId: 'getOpenApiSpec',
      summary: 'This spec — self-describing',
      description:
        'Returns this OpenAPI 3.1 document as YAML. Consumed by ChatGPT Custom GPT Actions (Phase D) and tooling that prefers an authoritative spec URL.',
      responses: {
        200: {
          description: 'OpenAPI 3.1 YAML document',
          content: {
            'application/yaml': {
              schema: { type: 'string', description: 'OpenAPI 3.1 YAML text' },
            },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level spec
// ---------------------------------------------------------------------------

function buildSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'universal-memory',
      version: '0.3.0-alpha',
      description:
        'HTTP API for universal-memory session continuity layer. Markdown-first vault + vector index via mem0. Exposes REST endpoints under /api/* and an MCP (JSON-RPC 2.0) endpoint at /mcp.',
      license: {
        name: 'MIT',
        url: 'https://github.com/goldenwo/universal-memory/blob/main/LICENSE',
      },
    },
    servers: [
      {
        url: 'http://localhost:6335',
        description: 'Local dev — default MEM0_MCP_PORT',
      },
    ],
    tags: [
      { name: 'health', description: 'Liveness and self-description' },
      { name: 'search', description: 'Semantic search + retrieval' },
      { name: 'mutations', description: 'Add / reindex / delete' },
      { name: 'state', description: 'Project state-of-play (vault-direct)' },
      { name: 'mcp', description: 'MCP JSON-RPC protocol endpoint' },
    ],
    paths: {
      '/health': pathHealth(),
      '/openapi.yaml': pathOpenapi(),
      '/api/search': pathSearch(),
      '/api/add': pathAdd(),
      '/api/list': pathList(),
      '/api/reindex': pathReindex(),
      '/api/state/{project}': pathState(),
      '/api/recent/{project}': pathRecent(),
      '/api/delete': pathDelete(),
      '/api/{id}': pathDeleteById(),
      '/mcp': pathMcp(),
    },
    components: {
      schemas: SCHEMAS,
    },
  };
}

/**
 * Generate the full OpenAPI 3.1 spec as a YAML string. Safe to call on every
 * request (~few ms); no IO.
 */
export function generateOpenAPISpec() {
  const spec = buildSpec();
  return YAML.stringify(spec);
}

// ---------------------------------------------------------------------------
// Custom GPT Actions (trimmed) spec — Phase D Task D2
// ---------------------------------------------------------------------------

/**
 * Strip 5xx responses from an operation object in-place. ChatGPT Custom GPT
 * Actions validators flag server-error schemas on several action types; only
 * 2xx and 4xx responses should reach the imported spec.
 */
function strip5xxResponses(operation) {
  if (!operation || !operation.responses) return;
  for (const code of Object.keys(operation.responses)) {
    if (/^5\d\d$/.test(code)) {
      delete operation.responses[code];
    }
  }
}

/**
 * Return a deep-cloned operation with the given `operationId` and all 5xx
 * responses removed. Used to derive Custom-GPT-ready operations from the
 * same per-path builders as the full spec (single source of truth for
 * request/response shapes).
 */
function cloneAndRewriteOperation(operation, operationId) {
  const clone = JSON.parse(JSON.stringify(operation));
  clone.operationId = operationId;
  strip5xxResponses(clone);
  return clone;
}

/**
 * Walk a JSON value and collect every `#/components/schemas/<Name>` reference.
 * Used to prune `components.schemas` down to only what the trimmed paths
 * actually reference (transitively).
 */
function collectRefs(node, acc) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') {
      const m = v.match(/^#\/components\/schemas\/(.+)$/);
      if (m) acc.add(m[1]);
    } else {
      collectRefs(v, acc);
    }
  }
}

/**
 * Generate the trimmed OpenAPI 3.1 spec for ChatGPT Custom GPT Actions.
 * Only the 5 routes the GPT needs (search/state/add/delete/recent), operationIds
 * renamed to the MCP-tool-style names ChatGPT surfaces to the model, all
 * 5xx responses stripped, and `components.schemas` pruned to only those
 * schemas still referenced by the kept paths.
 *
 * Output is YAML text. Served from GET /openapi.yaml?gpt=1 and also shipped
 * as the static file plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml.
 */
export function generateCustomGPTActionsSpec() {
  // Re-use the per-path builders rather than going through buildSpec() so
  // we don't widen the internal-export surface area just for this.
  const searchPath = pathSearch();
  const statePath = pathState();
  const addPath = pathAdd();
  const deletePath = pathDelete();
  const recentPath = pathRecent();

  // POST /api/search only (drop GET; POST has richer filter support)
  const trimmedSearch = {
    post: cloneAndRewriteOperation(searchPath.post, 'memory_search'),
  };
  // GET /api/state/{project}
  const trimmedState = {
    get: cloneAndRewriteOperation(statePath.get, 'memory_state'),
  };
  // POST /api/add
  const trimmedAdd = {
    post: cloneAndRewriteOperation(addPath.post, 'memory_add'),
  };
  // POST /api/delete
  const trimmedDelete = {
    post: cloneAndRewriteOperation(deletePath.post, 'memory_delete'),
  };
  // GET /api/recent/{project}
  const trimmedRecent = {
    get: cloneAndRewriteOperation(recentPath.get, 'memory_recent'),
  };

  const paths = {
    '/api/search': trimmedSearch,
    '/api/state/{project}': trimmedState,
    '/api/add': trimmedAdd,
    '/api/delete': trimmedDelete,
    '/api/recent/{project}': trimmedRecent,
  };

  // Prune components.schemas to only those transitively referenced by the
  // trimmed paths. Start from the direct refs in `paths`, then expand
  // through each included schema until the set stops growing.
  const kept = new Set();
  collectRefs(paths, kept);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of Array.from(kept)) {
      const schema = SCHEMAS[name];
      if (!schema) continue;
      const before = kept.size;
      collectRefs(schema, kept);
      if (kept.size !== before) changed = true;
    }
  }
  const trimmedSchemas = {};
  for (const name of kept) {
    if (SCHEMAS[name]) trimmedSchemas[name] = SCHEMAS[name];
  }

  // Re-use info/servers from the full spec but drop tags (the trimmed
  // spec's 5 operations don't need them and several Custom-GPT validators
  // flag unknown tags).
  const full = buildSpec();
  const trimmed = {
    openapi: full.openapi,
    info: {
      ...full.info,
      description:
        'ChatGPT Custom GPT Actions surface for universal-memory. Trimmed subset of the full spec — only the 5 routes a Custom GPT needs (search, state, add, delete, recent). Full spec at /openapi.yaml.',
    },
    servers: full.servers,
    paths,
    components: { schemas: trimmedSchemas },
  };

  const yaml = YAML.stringify(trimmed);
  return yaml.endsWith('\n') ? yaml : yaml + '\n';
}
