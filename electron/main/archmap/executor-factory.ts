import type { SessionOrchestrator } from '../../../src/types';
import { mapOrchestratorToAgentPatch } from '../agent-sync';
import { executeAgent } from '../agent-runtime/execute';
import {
  createArchmapAgentExecutor,
  type ArchmapAgentCall,
  type ArchmapAgentExecutor,
  type ArchmapAgentPatch,
} from './agent-executor';

export function archmapPatchFromSelection(selection: SessionOrchestrator): ArchmapAgentPatch {
  const patch = mapOrchestratorToAgentPatch({ ...selection, source: 'request' });
  if (!patch.runtime || !patch.model) {
    throw new Error(`Selecao sem runtime/modelo resolvido: ${selection.runtime}/${selection.provider}`);
  }
  return {
    runtime: patch.runtime,
    model: patch.model,
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.localConfig !== undefined ? { localConfig: patch.localConfig } : {}),
    ...(patch.externalConfig !== undefined ? { externalConfig: patch.externalConfig } : {}),
    ...(patch.codexConfig !== undefined ? { codexConfig: patch.codexConfig } : {}),
    ...(patch.localMode !== undefined ? { localMode: patch.localMode } : {}),
  };
}

export function createDefaultArchmapExecutor(
  selection: SessionOrchestrator,
  onCall?: (call: ArchmapAgentCall) => void,
): ArchmapAgentExecutor {
  return createArchmapAgentExecutor({ selection, executeAgent, patchFor: archmapPatchFromSelection, onCall });
}
