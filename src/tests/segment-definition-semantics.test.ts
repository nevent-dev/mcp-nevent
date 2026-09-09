/**
 * Contract tests for the boolean semantics of the segment definition DSL.
 *
 * The canonical engine is nev-data-api `SegmentExecutionService`:
 *   - criteria inside ONE stanza are OR-combined  (UNION DISTINCT — any criterion matches)
 *   - stanzas are AND-combined                    (INTERSECT DISTINCT — every stanza must match)
 *
 * The admin segment builder UI states the same thing ("criteria with OR",
 * "Add group (AND)"). Every consumer-facing description the MCP server ships
 * must therefore describe THAT algebra, in both directions.
 *
 * Sections:
 *   A — Zod `.description` contract on each schema surface.
 *   B — Registered-tool contract as the SDK actually serves it to consumers.
 *   C — Source-text guard against the inverted phrasings.
 *   D — Deterministic set-algebra coverage + forwarding fidelity.
 *
 * D1 and D2 are regression guards, not defect reproductions: they are EXPECTED
 * to pass on the unchanged base. The defect is contract TEXT only — the DSL is
 * forwarded to the API untouched, and no operator is ever swapped client-side.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  SegmentDefinitionSchema,
  SegmentPreviewSchema,
  SegmentExecuteSchema,
} from '../schemas/analytics.js';
import { CreateSegmentSchema, UpdateSegmentSchema } from '../schemas/segments.js';
import { registerAnalyticsTools } from '../tools/analytics.js';
import { registerSegmentTools } from '../tools/segments.js';
import { DataClient } from '../clients/data-client.js';
import type { SegmentDefinition } from '../types/segmentation.js';
import { SEGMENT_SEMANTICS_CASES } from './fixtures/segment-definition-semantics.js';

// ---------------------------------------------------------------------------
// Shared helper: the canonical boolean-semantics assertion
// ---------------------------------------------------------------------------

/** Split a description into clauses. Sentence and line boundaries only. */
function clausesOf(text: string): string[] {
  return text
    .split(/[.;\n]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

const mentionsCriteria = (clause: string): boolean => /criteri/i.test(clause);
const mentionsStanzas = (clause: string): boolean => /\bstanzas\b/i.test(clause);

/** Does the clause claim OR / "any of" semantics? Bare `OR` counts only uppercase. */
const statesOr = (clause: string): boolean =>
  /\bOR\b/.test(clause) || /OR-combined|OR logic|\bany\b|\bunion\b/i.test(clause);

/** Does the clause claim AND / "all of" semantics? Bare `AND` counts only uppercase. */
const statesAnd = (clause: string): boolean =>
  /\bAND\b/.test(clause) || /AND-combined|AND logic|\bevery\b|\ball\b|\bintersect/i.test(clause);

/** The inverted claim: criteria described as AND-combined. */
const invertsCriteria = (clause: string): boolean =>
  mentionsCriteria(clause) && /AND-combined|AND logic|match ALL criteria/i.test(clause);

/** The inverted claim: stanzas described as OR-combined. */
const invertsStanzas = (clause: string): boolean =>
  mentionsStanzas(clause) && /OR-combined|OR logic|match ANY stanza|OR groups/i.test(clause);

/**
 * Assert that `text` describes the canonical algebra: criteria OR within a
 * stanza, stanzas AND between each other — and never the reverse.
 *
 * @param text  - The consumer-facing description under test.
 * @param label - Surface identifier printed in every failure message.
 */
function expectCanonicalBooleanSemantics(text: string | undefined, label: string): void {
  expect(
    typeof text,
    `${label}: no description present — the boolean semantics contract is undocumented.`
  ).toBe('string');

  const value = text as string;
  const clauses = clausesOf(value);

  const criteriaOrClause = clauses.find((c) => mentionsCriteria(c) && statesOr(c));
  expect(
    criteriaOrClause,
    `${label}: no clause states that criteria WITHIN a stanza are OR-combined ` +
      `(a fan matching ANY criterion is included).\nText: ${value}`
  ).toBeDefined();

  const stanzasAndClause = clauses.find((c) => mentionsStanzas(c) && statesAnd(c));
  expect(
    stanzasAndClause,
    `${label}: no clause states that stanzas are AND-combined ` +
      `(a fan must match EVERY stanza).\nText: ${value}`
  ).toBeDefined();

  const inverted = clauses.filter((c) => invertsCriteria(c) || invertsStanzas(c));
  expect(
    inverted,
    `${label}: clause(s) state the INVERTED semantics.\n` +
      `Offending clause(s): ${inverted.map((c) => `"${c}"`).join(' | ')}\nText: ${value}`
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Section A — Zod description contract
// ---------------------------------------------------------------------------

/** Peel `ZodOptional` / `ZodDefault` wrappers to reach the inner schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    current = (current._def as { innerType: z.ZodTypeAny }).innerType;
  }
  return current;
}

/** Read a `.description`, falling back to the unwrapped inner schema. */
function describedBy(schema: z.ZodTypeAny): string | undefined {
  return schema.description ?? unwrap(schema).description;
}

describe('A. Zod description contract — segment definition boolean semantics', () => {
  it('SegmentDefinitionSchema.stanzas describes stanzas as AND-combined', () => {
    expectCanonicalBooleanSemantics(
      describedBy(SegmentDefinitionSchema.shape.stanzas),
      'SegmentDefinitionSchema.shape.stanzas.description'
    );
  });

  it('SegmentStanzaSchema.criteria describes criteria as OR-combined', () => {
    const stanzaSchema = unwrap(SegmentDefinitionSchema.shape.stanzas) as z.ZodArray<z.ZodTypeAny>;
    const stanzaObject = unwrap(stanzaSchema.element) as z.ZodObject<z.ZodRawShape>;
    expectCanonicalBooleanSemantics(
      describedBy(stanzaObject.shape['criteria'] as z.ZodTypeAny),
      'SegmentDefinitionSchema.shape.stanzas.element.shape.criteria.description'
    );
  });

  it('SegmentPreviewSchema.definition describes the canonical semantics', () => {
    expectCanonicalBooleanSemantics(
      describedBy(SegmentPreviewSchema.definition),
      'SegmentPreviewSchema.definition.description'
    );
  });

  it('SegmentExecuteSchema.definition describes the canonical semantics', () => {
    expectCanonicalBooleanSemantics(
      describedBy(SegmentExecuteSchema.definition),
      'SegmentExecuteSchema.definition.description'
    );
  });

  it('CreateSegmentSchema.definition describes the canonical semantics', () => {
    expectCanonicalBooleanSemantics(
      describedBy(CreateSegmentSchema.definition),
      'CreateSegmentSchema.definition.description'
    );
  });

  it('UpdateSegmentSchema.definition describes the canonical semantics', () => {
    expectCanonicalBooleanSemantics(
      describedBy(UpdateSegmentSchema.definition),
      'UpdateSegmentSchema.definition.description'
    );
  });
});

// ---------------------------------------------------------------------------
// Section B — Registered-tool contract through the real SDK
// ---------------------------------------------------------------------------

/** JSON Schema fragment shape we navigate in the served tool definitions. */
interface JsonSchemaNode {
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
}

interface ServedTool {
  name: string;
  description?: string;
  inputSchema: JsonSchemaNode;
}

/** Minimal DataClient stub — tool registration never touches the network. */
function makeStubDataClient() {
  return {
    activeTenantId: undefined as string | undefined,
    getJwtToken() {
      return 'test-jwt';
    },
  } as unknown as DataClient;
}

describe('B. Registered-tool contract — what consumers actually receive', () => {
  let client: Client;
  let servedTools: ServedTool[];

  beforeAll(async () => {
    const server = new McpServer({ name: 'mcp-nevent-test', version: '0.0.0-test' });
    const stub = makeStubDataClient();
    registerAnalyticsTools(server, stub);
    registerSegmentTools(server, stub, 'https://api.example.test');

    client = new Client({ name: 'semantics-test-client', version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const listed = await client.listTools();
    servedTools = listed.tools as unknown as ServedTool[];
  });

  afterAll(async () => {
    await client?.close();
  });

  /** Find a served tool by name, failing loudly when the registration moved. */
  function toolNamed(name: string): ServedTool {
    const found = servedTools.find((tool) => tool.name === name);
    expect(found, `tool "${name}" is not registered on the MCP server`).toBeDefined();
    return found as ServedTool;
  }

  const DEFINITION_TOOLS = [
    'nevent_segment_preview',
    'nevent_segment_execute',
    'nevent_create_segment',
    'nevent_update_segment',
  ];

  for (const toolName of DEFINITION_TOOLS) {
    describe(toolName, () => {
      it('definition.description states the canonical semantics', () => {
        const definition = toolNamed(toolName).inputSchema.properties?.['definition'];
        expect(
          definition,
          `${toolName}: inputSchema.properties.definition is absent`
        ).toBeDefined();

        // Only assert when the surface carries a description at all; the
        // stanzas/criteria assertions below always apply.
        if (definition?.description !== undefined) {
          expectCanonicalBooleanSemantics(
            definition.description,
            `${toolName} → inputSchema.properties.definition.description`
          );
        }
      });

      it('definition.stanzas.description states the canonical semantics', () => {
        const stanzas =
          toolNamed(toolName).inputSchema.properties?.['definition']?.properties?.['stanzas'];
        expectCanonicalBooleanSemantics(
          stanzas?.description,
          `${toolName} → inputSchema.properties.definition.properties.stanzas.description`
        );
      });

      it('definition.stanzas.items.criteria.description states the canonical semantics', () => {
        const criteria =
          toolNamed(toolName).inputSchema.properties?.['definition']?.properties?.['stanzas']
            ?.items?.properties?.['criteria'];
        expectCanonicalBooleanSemantics(
          criteria?.description,
          `${toolName} → inputSchema.properties.definition.properties.stanzas.items.properties.criteria.description`
        );
      });
    });
  }

  // The tool-level description is the first thing an agent reads. The three
  // segment-building tools must state the algebra there too.
  for (const toolName of ['nevent_segment_preview', 'nevent_segment_execute', 'nevent_create_segment']) {
    it(`${toolName} tool description states the canonical semantics`, () => {
      expectCanonicalBooleanSemantics(
        toolNamed(toolName).description,
        `${toolName} → tool description`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Section C — Source-text guard
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GUARDED_FILES = [
  'src/schemas/analytics.ts',
  'src/schemas/segments.ts',
  'src/types/segmentation.ts',
  'src/tools/analytics.ts',
  'src/tools/segments.ts',
  'src/tools/help.ts',
  'src/server-instructions.ts',
];

/** Phrasings that assert the inverted algebra. Each is a hard failure. */
const INVERTED_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'criteria described as AND-combined', pattern: /criteria[^.\n]*AND-combined/i },
  { label: 'AND logic within a stanza', pattern: /AND logic[^.\n]*(within|in) (this|a|the) stanza/i },
  { label: 'criteria (AND logic)', pattern: /criteria \(AND logic\)/i },
  { label: 'stanzas described as OR-combined', pattern: /stanzas[^.\n]*OR-combined/i },
  { label: 'stanzas (OR logic)', pattern: /stanzas \(OR logic\)/i },
  { label: 'match ANY stanza', pattern: /match ANY stanza/i },
  { label: 'match ALL criteria', pattern: /match ALL criteria/i },
  { label: 'stanzas = OR groups', pattern: /stanzas = OR groups/i },
  { label: 'criteria = AND within', pattern: /criteria = AND within/i },
  { label: '(OR) ... (AND)', pattern: /\(OR\)[^.\n]*\(AND\)/ },
];

describe('C. Source-text guard — no inverted boolean-semantics phrasing', () => {
  for (const relativePath of GUARDED_FILES) {
    it(`${relativePath} contains no inverted phrasing`, () => {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      const offenders: string[] = [];

      source.split('\n').forEach((line, index) => {
        for (const { label, pattern } of INVERTED_PATTERNS) {
          if (pattern.test(line)) {
            offenders.push(`${relativePath}:${index + 1}: [${label}] ${line.trim()}`);
          }
        }
      });

      expect(
        offenders,
        `Inverted boolean-semantics phrasing found:\n${offenders.join('\n')}`
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Section D — Deterministic set semantics + forwarding fidelity
// ---------------------------------------------------------------------------

/**
 * Reference evaluator for the canonical algebra:
 * criterion = its member set, stanza = UNION of criteria, definition = INTERSECT of stanzas.
 */
function evaluate(definition: SegmentDefinition, members: Record<string, string[]>): string[] {
  const stanzaSets = definition.stanzas.map((stanza) => {
    const matched = new Set<string>();
    for (const criterion of stanza.criteria) {
      for (const fan of members[criterion.id ?? ''] ?? []) matched.add(fan);
    }
    return matched;
  });
  const [first, ...rest] = stanzaSets;
  return [...(first ?? new Set<string>())]
    .filter((fan) => rest.every((stanzaSet) => stanzaSet.has(fan)))
    .sort();
}

describe('D1. Canonical set algebra — union within a stanza, intersection between stanzas', () => {
  for (const testCase of SEGMENT_SEMANTICS_CASES) {
    it(testCase.name, () => {
      expect(evaluate(testCase.definition, testCase.criterionMembers)).toEqual(testCase.expected);
    });
  }
});

/** Strip auto-generated `id` fields so grouping/order/values can be compared. */
function stripIds(definition: SegmentDefinition): unknown {
  return {
    stanzas: definition.stanzas.map((stanza) => ({
      criteria: stanza.criteria.map((criterion) => {
        const { id: _criterionId, ...rest } = criterion;
        return rest;
      }),
    })),
  };
}

/** Minimal JSON-ok fetch Response, matching the data-client test helpers. */
function mockJsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

describe('D2. Forwarding fidelity — grouping reaches the API untouched', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Read the `definition` the client actually POSTed. */
  function sentDefinition(): SegmentDefinition {
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    return (JSON.parse(init.body) as { definition: SegmentDefinition }).definition;
  }

  for (const testCase of SEGMENT_SEMANTICS_CASES) {
    it(`previewSegment forwards grouping unchanged — ${testCase.name}`, async () => {
      mockFetch.mockResolvedValue(mockJsonOk({ estimated_fan_count: 0, sample_fans: [] }));
      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      await client.previewSegment(testCase.definition);

      expect(stripIds(sentDefinition())).toEqual(stripIds(testCase.definition));
    });

    it(`executeSegment forwards grouping unchanged — ${testCase.name}`, async () => {
      mockFetch.mockResolvedValue(
        mockJsonOk({ total_fans: 0, fans: [], current_page: 0, total_pages: 0, has_more: false })
      );
      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      await client.executeSegment(testCase.definition);

      expect(stripIds(sentDefinition())).toEqual(stripIds(testCase.definition));
    });
  }
});
