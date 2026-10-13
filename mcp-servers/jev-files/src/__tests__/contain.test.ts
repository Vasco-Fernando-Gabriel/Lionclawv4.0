import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BINARY_EXTENSIONS,
  EXTENDED_PREFIX_MESSAGE,
  SENSITIVE_DIR_NAMES,
  SENSITIVE_FILE_PATTERNS,
  classifyTarget,
  containFile,
  foldCase,
  hasAlternateStream,
  hasBinaryExtension,
  isBinaryContent,
  isInside,
  isSensitiveFileName,
  isSensitivePath,
} from '../contain';

const WIN32 = process.platform === 'win32';

let tmp = '';
let root = '';
let outside = '';

function write(rel: string, content = 'texto\n'): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-files-contain-')));
  root = path.join(tmp, 'root');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('contain: classificacao do alvo', () => {
  it('prefixo estendido, relativo, glob e caminho', () => {
    expect(classifyTarget('\\\\?\\C:\\proj\\a.ts')).toBe('extended');
    expect(classifyTarget('\\\\.\\C:\\proj\\a.ts')).toBe('extended');
    expect(classifyTarget('\\\\?\\C:\\proj\\*.ts')).toBe('extended');
    expect(classifyTarget('src/a.ts')).toBe('relative');
    expect(classifyTarget('./a.ts')).toBe('relative');
    expect(classifyTarget(path.join(root, '**', '*.ts'))).toBe('glob');
    expect(classifyTarget(path.join(root, 'a?.ts'))).toBe('glob');
    expect(classifyTarget(path.join(root, '{a,b}.ts'))).toBe('glob');
    expect(classifyTarget(path.join(root, 'a.ts'))).toBe('path');
  });

  it('isInside exige separador: prefixo de nome nao conta', () => {
    expect(isInside(path.join(root, 'a.ts'), root)).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(`${root}2${path.sep}a.ts`, root)).toBe(false);
    expect(isInside(path.join(tmp, 'a.ts'), root)).toBe(false);
  });

  it.runIf(WIN32)('win32: isInside ignora maiusculas e aceita raiz na raiz do drive', () => {
    expect(isInside(path.join(root.toUpperCase(), 'A.TS'), root)).toBe(true);
    expect(isInside('C:\\proj\\a.ts', 'c:\\PROJ')).toBe(true);
    expect(isInside('C:\\a.ts', 'C:\\')).toBe(true);
    expect(isInside('D:\\a.ts', 'C:\\')).toBe(false);
    expect(foldCase('C:\\A')).toBe('c:\\a');
  });

  it.runIf(!WIN32)('posix: isInside distingue maiusculas', () => {
    expect(isInside(path.join(root.toUpperCase(), 'A.TS'), root)).toBe(false);
  });

  it('fluxo alternativo (ADS) so e detectado no win32 e ignora a letra do drive', () => {
    if (WIN32) {
      expect(hasAlternateStream('C:\\proj\\.env::$DATA')).toBe(true);
      expect(hasAlternateStream('C:\\proj\\a.ts:stream')).toBe(true);
      expect(hasAlternateStream('C:\\proj\\a.ts')).toBe(false);
      expect(hasAlternateStream('\\\\server\\share\\a.ts:x')).toBe(true);
    } else {
      expect(hasAlternateStream('/proj/.env::$DATA')).toBe(false);
    }
  });
});

describe('contain: politica de sensiveis (lista versionada)', () => {
  it('nomes de arquivo', () => {
    for (const name of [
      '.env',
      '.env.local',
      '.env.production',
      '.envrc',
      'server.pem',
      'private.key',
      'cert.p12',
      'cert.pfx',
      'id_rsa',
      'id_rsa.pub',
      'id_ed25519',
      'app.secret',
      'app.secrets.json',
      'credentials.json',
      'aws_credentials',
      'terraform.tfstate',
      '.npmrc',
      '.netrc',
    ]) {
      expect(isSensitiveFileName(name), name).toBe(true);
    }
    for (const name of ['env.ts', 'keyboard.ts', 'README.md', 'environment.json', 'secretary.ts', 'envrc.md']) {
      expect(isSensitiveFileName(name), name).toBe(false);
    }
    expect(SENSITIVE_FILE_PATTERNS.length).toBe(14);
  });

  it('pastas abaixo da raiz e o par .lionclaw/data em qualquer ponto', () => {
    for (const dir of [
      '.git',
      'node_modules',
      'dist',
      'build',
      '.venv',
      '.venv311',
      '__pycache__',
      '.ssh',
      '.aws',
      '.gnupg',
    ]) {
      expect(isSensitivePath(path.join(root, dir, 'x.txt'), root), dir).toBe(true);
      expect(isSensitivePath(path.join(root, 'sub', dir, 'deep', 'x.txt'), root), dir).toBe(true);
    }
    expect(isSensitivePath(path.join(root, 'src', 'x.txt'), root)).toBe(false);
    expect(isSensitivePath(path.join(root, 'distribuicao', 'x.txt'), root)).toBe(false);
    expect(isSensitivePath(path.join(root, '.lionclaw', 'data', 'x.json'), root)).toBe(true);
    expect(isSensitivePath(path.join(root, '.lionclaw', 'workspaces', 'x.json'), root)).toBe(false);
    expect(SENSITIVE_DIR_NAMES).toContain('.git');
  });

  it('uma raiz dentro de uma pasta chamada build nao recusa tudo abaixo dela', () => {
    const buildRoot = path.join(root, 'build');
    expect(isSensitivePath(path.join(buildRoot, 'src', 'x.txt'), buildRoot)).toBe(false);
  });
});

describe('contain: binario', () => {
  it('por extensao, sem diferenciar maiusculas', () => {
    for (const ext of [
      '.png',
      '.PNG',
      '.mp3',
      '.zip',
      '.exe',
      '.db',
      '.sqlite',
      '.wasm',
      '.pdf',
      '.docx',
      '.xlsx',
      '.ttf',
    ]) {
      expect(hasBinaryExtension(`arquivo${ext}`), ext).toBe(true);
    }
    for (const ext of ['.ts', '.md', '.json', '.txt', '']) {
      expect(hasBinaryExtension(`arquivo${ext}`), ext).toBe(false);
    }
    expect(BINARY_EXTENSIONS.has('.sqlite')).toBe(true);
  });

  it('por byte nulo nos primeiros 8 KB', () => {
    const buf = Buffer.concat([Buffer.from('a'.repeat(100)), Buffer.from([0]), Buffer.from('b'.repeat(100))]);
    expect(isBinaryContent(buf)).toBe(true);
    const late = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0])]);
    expect(isBinaryContent(late)).toBe(false);
  });

  it('por excesso de bytes de controle fora de tab e quebra', () => {
    const controls = Buffer.alloc(10, 0x01);
    const text = Buffer.from('x'.repeat(90));
    expect(isBinaryContent(Buffer.concat([controls, text]))).toBe(true);
    const few = Buffer.concat([Buffer.alloc(4, 0x01), Buffer.from('x'.repeat(96))]);
    expect(isBinaryContent(few)).toBe(false);
    const whitespace = Buffer.from('a\tb\nc\r\n'.repeat(50));
    expect(isBinaryContent(whitespace)).toBe(false);
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false);
  });
});

describe('containFile', () => {
  it('arquivo dentro da raiz passa com caminho pedido e real', async () => {
    const file = write('src/a.ts');
    const result = await containFile(file, [root], fs.promises);
    expect(result).toEqual({ ok: true, file: { requestedPath: file, realPath: file, root } });
  });

  it('caminho relativo e recusado com relative_path', async () => {
    const result = await containFile('src/a.ts', [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('relative_path');
  });

  it('prefixo estendido e recusado antes do teste de glob, com mensagem propria', async () => {
    for (const target of [`\\\\?\\${root}\\a.ts`, `\\\\.\\${root}\\a.ts`, `\\\\?\\${root}\\*.ts`]) {
      const result = await containFile(target, [root], fs.promises);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unreadable');
        expect(result.message).toBe(EXTENDED_PREFIX_MESSAGE);
      }
    }
  });

  it('glob nao passa pela contencao de arquivo', async () => {
    const result = await containFile(path.join(root, '*.ts'), [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreadable');
  });

  it('fora da raiz => outside_roots (inclusive sem raiz valida)', async () => {
    const file = path.join(outside, 'a.ts');
    fs.writeFileSync(file, 'x');
    const result = await containFile(file, [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside_roots');
    expect((await containFile(file, [], fs.promises)).ok).toBe(false);
  });

  it('subida com .. que sai da raiz => outside_roots', async () => {
    const file = path.join(outside, 'a.ts');
    fs.writeFileSync(file, 'x');
    const result = await containFile(path.join(root, '..', 'outside', 'a.ts'), [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside_roots');
  });

  it('raiz inexistente e ignorada, outra raiz valida continua valendo', async () => {
    const file = write('a.ts');
    expect((await containFile(file, [path.join(tmp, 'nao-existe'), root], fs.promises)).ok).toBe(true);
  });

  it('link para fora da raiz => outside_roots pelo caminho real', async () => {
    fs.writeFileSync(path.join(outside, 'segredo.txt'), 'x');
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    const result = await containFile(path.join(root, 'link', 'segredo.txt'), [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside_roots');
  });

  it('sensivel pelo nome pedido', async () => {
    for (const rel of [
      '.env',
      '.envrc',
      'certs/server.pem',
      'node_modules/x/index.js',
      '.git/config',
      'sub/.ssh/known',
    ]) {
      const file = write(rel);
      const result = await containFile(file, [root], fs.promises);
      expect(result.ok, rel).toBe(false);
      if (!result.ok) expect(result.reason, rel).toBe('sensitive');
    }
  });

  it('sensivel pelo caminho real mesmo com pedido limpo', async () => {
    write('.ssh/chave.txt');
    fs.symlinkSync(path.join(root, '.ssh'), path.join(root, 'limpo'), 'junction');
    const result = await containFile(path.join(root, 'limpo', 'chave.txt'), [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('sensitive');
  });

  it.runIf(WIN32)('win32: fluxo alternativo .env::$DATA e recusado como sensivel', async () => {
    write('.env', 'A=1');
    const result = await containFile(`${path.join(root, '.env')}::$DATA`, [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('sensitive');
    const stream = await containFile(`${path.join(root, 'a.ts')}:hidden`, [root], fs.promises);
    expect(stream.ok).toBe(false);
    if (!stream.ok) expect(stream.reason).toBe('sensitive');
  });

  it.runIf(WIN32)('win32: nome curto 8.3 de um arquivo sensivel cai em sensitive pelo caminho real', async () => {
    const long = write('verylongfilename-credentials.json', '{}');
    let shortFull = '';
    try {
      shortFull = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${long}').ShortPath`],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
    } catch {
      return;
    }
    if (shortFull.length === 0 || foldCase(shortFull) === foldCase(long)) return;
    const short = path.join(root, path.basename(shortFull));
    expect(path.basename(short)).not.toMatch(/credentials/i);
    expect(path.basename(short)).toMatch(/~/);
    const result = await containFile(short, [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('sensitive');
  });

  it('binario por extensao', async () => {
    const result = await containFile(write('img/logo.png', 'nao importa'), [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('binary');
  });

  it('inexistente => unreadable com a mensagem do sistema', async () => {
    const result = await containFile(path.join(root, 'nao-existe.ts'), [root], fs.promises);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unreadable');
      expect(result.message).toMatch(/ENOENT/);
    }
  });

  it('pasta como alvo e reconhecida como pasta, com caminho real e raiz', async () => {
    fs.mkdirSync(path.join(root, 'pasta'));
    const result = await containFile(path.join(root, 'pasta'), [root], fs.promises);
    expect(result).toEqual({
      ok: true,
      directory: path.join(root, 'pasta'),
      realPath: path.join(root, 'pasta'),
      root,
    });
  });

  it('pasta cujo ultimo segmento e sensivel e recusada, inclusive pelo caminho real', async () => {
    fs.mkdirSync(path.join(root, 'node_modules'));
    const direct = await containFile(path.join(root, 'node_modules'), [root], fs.promises);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.reason).toBe('sensitive');
    fs.mkdirSync(path.join(root, '.git'));
    fs.symlinkSync(path.join(root, '.git'), path.join(root, 'limpo'), 'junction');
    const viaLink = await containFile(path.join(root, 'limpo'), [root], fs.promises);
    expect(viaLink.ok).toBe(false);
    if (!viaLink.ok) expect(viaLink.reason).toBe('sensitive');
  });
});
