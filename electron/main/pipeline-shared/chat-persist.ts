import { persistSwarmChatMessageOnce } from '../db';
import type { SwarmDeliveryRef } from '../../../src/types/swarm';

export interface SwarmChatTarget {
  kind: 'chat';
  sessionId: string;
  swarmDelivery: SwarmDeliveryRef;
  messageKind: 'event' | 'response';
  serializedMetadata?: string;
}
export function persistSwarmChatMessage(target: SwarmChatTarget, role: 'system' | 'assistant', content: string): void {
  if (role !== (target.messageKind === 'event' ? 'system' : 'assistant')) {
    throw new Error('Papel incompatível com a mensagem Swarm.');
  }
  persistSwarmChatMessageOnce({
    runId: target.swarmDelivery.runId,
    kind: target.swarmDelivery.kind,
    revision: target.swarmDelivery.revision,
    claimId: target.swarmDelivery.claimId,
    sessionId: target.sessionId,
    messageKind: target.messageKind,
    content,
    metadata: target.serializedMetadata,
  });
}
