import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  SWARM_MESSAGE_DESCRIPTION,
  SWARM_READ_DESCRIPTION,
  SWARM_REDISPATCH_DESCRIPTION,
  SWARM_START_DESCRIPTION,
  SWARM_STOP_DESCRIPTION,
  SWARM_WAIT_DESCRIPTION,
} from '../../_shared/swarm-guidance.js';
import { LocalIpcClient, assertEndpointPresentOrExit, withTurnBinding } from '../../_shared/local-ipc-client.js';
import { swarmRedispatchShape, swarmStartShape } from './schema.js';
assertEndpointPresentOrExit();
const client = new LocalIpcClient();
const server = new McpServer({ name: 'lionclaw-swarm', version: '1.1.0' });
async function proxy(method: string, params: Record<string, unknown>, extra?: unknown) {
  try {
    const result = await client.callMethod(method, withTurnBinding(params, extra));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(result && typeof result === 'object' && 'error' in result ? { isError: true } : {}),
    };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: String(error) }], isError: true };
  }
}
const isWorker = process.env['LIONCLAW_SWARM_WORKER'] === '1';
if (isWorker) {
  server.tool(
    'swarm_write_findings',
    'Envia relatório em partes: begin, chunk sequencial, finalize com SHA-256 UTF-8. Reenvios idênticos são seguros.',
    {
      operation: z.enum(['begin', 'chunk', 'finalize']),
      uploadId: z.string(),
      seq: z.number().int().nonnegative().optional(),
      content: z.string().optional(),
      chunkCount: z.number().int().nonnegative().optional(),
      sha256: z.string().optional(),
    },
    (upload) => proxy('swarm_write_findings', { upload }),
  );
} else {
  server.tool('swarm_start', SWARM_START_DESCRIPTION, swarmStartShape, (params, extra) =>
    proxy('swarm_start', params, extra),
  );
  server.tool(
    'swarm_inspect',
    'Consulta estado e resultados da run nesta sessão (manifesto: swarm agents, execucoes, custo).',
    { runId: z.string() },
    (params, extra) => proxy('swarm_inspect', params, extra),
  );
  server.tool(
    'swarm_abort',
    'Cancela a run inteira preservando resultados concluídos. Só com pedido do usuário.',
    { runId: z.string() },
    (params, extra) => proxy('swarm_abort', params, extra),
  );
  server.tool(
    'swarm_list',
    'Lista runs da sessão atual.',
    { cursor: z.string().optional(), limit: z.number().int().positive().max(50).optional() },
    (params, extra) => proxy('swarm_list', params, extra),
  );
  server.tool(
    'swarm_catalog',
    'Lista swarm agents (generic:true primeiro), perfis compatíveis disponíveis e a tabela runtimes (leitura confinada ou livre, escrita, shell, web, continuacao por sessao ou reenvio) de cada runtime.',
    {},
    (params, extra) => proxy('swarm_catalog', params, extra),
  );
  server.tool('swarm_read', SWARM_READ_DESCRIPTION, { runId: z.string(), slug: z.string() }, (params, extra) =>
    proxy('swarm_read', params, extra),
  );
  server.tool('swarm_stop', SWARM_STOP_DESCRIPTION, { runId: z.string(), slug: z.string() }, (params, extra) =>
    proxy('swarm_stop', params, extra),
  );
  server.tool(
    'swarm_redispatch',
    SWARM_REDISPATCH_DESCRIPTION,
    { runId: z.string(), slug: z.string(), briefing: swarmRedispatchShape },
    (params, extra) => proxy('swarm_redispatch', params, extra),
  );
  server.tool(
    'swarm_message',
    SWARM_MESSAGE_DESCRIPTION,
    {
      runId: z.string(),
      slug: z.string(),
      message: z.string().trim().min(1).max(32_000),
      attemptId: z.string().optional().describe('Obrigatório ao responder uma pergunta (vem em swarm_wait/entrega).'),
    },
    (params, extra) => proxy('swarm_message', params, extra),
  );
  server.tool(
    'swarm_wait',
    SWARM_WAIT_DESCRIPTION,
    {
      runId: z.string(),
      slugs: z.array(z.string()).min(1).max(100).optional().describe('Espera só estes swarm agents.'),
      sliceMs: z.number().int().min(1000).max(50_000).optional().describe('Fatia desta chamada (padrão 50000).'),
    },
    (params, extra) => proxy('swarm_wait', params, extra),
  );
}
await server.connect(new StdioServerTransport());
