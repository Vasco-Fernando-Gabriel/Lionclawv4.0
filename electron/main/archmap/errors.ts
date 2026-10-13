import type { ArchmapConfirmFullPayload } from '../../../src/types/archmap';

export class ArchmapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArchmapError';
    this.code = code;
  }
}

export class ArchmapRepositoryNotFoundError extends ArchmapError {
  constructor(repositoryId: string) {
    super('repository_not_found', `Repositorio nao encontrado: ${repositoryId}`);
  }
}

export class ArchmapDisabledError extends ArchmapError {
  constructor() {
    super('disabled', 'Mapa de arquitetura desligado nas configuracoes (archmap_enabled).');
  }
}

export class ArchmapBusyError extends ArchmapError {
  constructor(repositoryId: string, what: 'job' | 'queued' | 'estimate') {
    super(
      'busy',
      `Ja existe ${what === 'estimate' ? 'uma estimativa' : 'uma rodada'} em andamento para ${repositoryId}.`,
    );
  }
}

export class ArchmapEmptyError extends ArchmapError {
  constructor() {
    super('empty', 'Nenhum arquivo elegivel apos os filtros; nada para mapear.');
  }
}

export class ArchmapTooLargeError extends ArchmapError {
  readonly fileCount: number;
  readonly limit: number;
  constructor(fileCount: number, limit: number) {
    super(
      'too_large',
      `Repositorio com ${fileCount} arquivos apos os filtros, acima do teto de ${limit}. Reduza o escopo com .lionclaw/archmap.ignore antes de gerar o mapa.`,
    );
    this.fileCount = fileCount;
    this.limit = limit;
  }
}

export class ArchmapTimeoutError extends ArchmapError {
  constructor(operation: string, timeoutMs: number) {
    super('timeout', `A operacao "${operation}" excedeu ${Math.round(timeoutMs / 1000)} s.`);
  }
}

export class ArchmapCancelledError extends ArchmapError {
  constructor() {
    super('cancelled', 'Operacao cancelada.');
  }
}

export class ArchmapAbsentError extends ArchmapError {
  constructor(what: 'graph' | 'meta') {
    super('absent', what === 'graph' ? 'Mapa de arquitetura ausente.' : 'Metadados do mapa ausentes.');
  }
}

export class ArchmapGraphTooLargeError extends ArchmapError {
  constructor(size: number, limit: number) {
    super('graph_too_large', `Grafo com ${size} bytes acima do teto de ${limit} bytes.`);
  }
}

export class ArchmapFileError extends ArchmapError {
  readonly reason: string;
  constructor(reason: string, path: string) {
    super('file', `Arquivo do mapa indisponivel (${reason}): ${path}`);
    this.reason = reason;
  }
}

export class ArchmapGitTimeoutError extends ArchmapError {
  constructor(detail: string) {
    super('git_timeout', `git nao respondeu (${detail})`);
  }
}

export class ArchmapConfirmFullError extends ArchmapError {
  readonly details: ArchmapConfirmFullPayload;
  constructor(details: ArchmapConfirmFullPayload) {
    super('confirm_full', 'A atualizacao exige regeneracao completa do mapa; confirme com confirmFull.');
    this.details = details;
  }
}

export class ArchmapRunCreateError extends ArchmapError {
  constructor(repositoryId: string, cause: string) {
    super('run_create', `Falha ao registrar a rodada do mapa para ${repositoryId}: ${cause}`);
  }
}
