import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { cleanEnvironment } from './templates/isolation.mjs';

export const sourceExtensions = /\.(?:[cm]?[jt]sx?|py)$/;
export function imports(text, file) {
  if (file.endsWith('.py')) {
    const result = spawnSync('python3', ['-I', '-S', fileURLToPath(new URL('./python-imports.py', import.meta.url))], {
      input: JSON.stringify({ source: text }), encoding: 'utf8', env: cleanEnvironment(), timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) return [{ specifier: null, python: true, line: 1, error: 'Python syntax analysis failed; install Python 3.10+ and check source size/syntax' }];
    return JSON.parse(result.stdout);
  }
  const found = [];
  const chunks = /\.(vue|svelte|html|astro)$/.test(file)
    ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => ({ text: match[1], offset: match.index + match[0].indexOf('>') + 1 }))
    : [{ text, offset: 0 }];
  if (file.endsWith('.astro')) {
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (front) chunks.push({ text: front[1], offset: front[0].indexOf('\n') + 1 });
  }
  for (const chunk of chunks) {
    const source = ts.createSourceFile(file, chunk.text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lineAt = position => text.slice(0, chunk.offset + position).split('\n').length;
    const add = (value, node) => {
      const literal = value && (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value));
      found.push({ specifier: literal ? value.text : null, line: lineAt(node.getStart(source)), python: false,
        ...(!literal ? { error: 'Computed module import requires a literal path for deterministic seam analysis' } : {}) });
    };
    for (const diagnostic of source.parseDiagnostics) found.push({ specifier: null, line: lineAt(diagnostic.start ?? 0), error: `Source syntax error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}` });
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier, node);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node);
      else if (ts.isImportTypeNode(node)) add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null, node);
      else if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = expression.getText(source).replace(/\s+/g, '');
        if (expression.kind === ts.SyntaxKind.ImportKeyword || ['require', 'require.resolve', 'module.require'].includes(name)) add(node.arguments[0], node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

export function pathAliases(root) {
  function read(file, seen = new Set()) {
    if (seen.has(file) || seen.size > 16) throw new Error('Cyclic or excessively deep tsconfig inheritance');
    const next = new Set([...seen, file]);
    const parsed = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'));
    if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, ' '));
    const config = parsed.config;
    let inherited = {};
    if (config.extends) {
      for (const reference of Array.isArray(config.extends) ? config.extends : [config.extends]) {
        if (typeof reference !== 'string' || !reference.startsWith('.')) throw new Error('Config extends must be an explicit relative JSON file');
        let parent = path.resolve(path.dirname(file), reference);
        if (!fs.existsSync(parent)) parent += '.json';
        inherited = { ...inherited, ...read(parent, next) };
      }
    }
    const options = config.compilerOptions ?? {};
    const result = { ...inherited };
    if (options.baseUrl !== undefined) result.baseUrl = path.resolve(path.dirname(file), options.baseUrl);
    if (options.paths !== undefined) { result.paths = options.paths; result.pathsBase = path.dirname(file); }
    return result;
  }
  const aliases = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const config = read(file);
    if (config.paths && (typeof config.paths !== 'object' || Array.isArray(config.paths))) throw new Error('Config paths must be an object');
    for (const [key, values] of Object.entries(config.paths ?? {})) {
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string') || key.split('*').length > 2) throw new Error('Invalid path alias');
      for (const value of values) aliases.push({ key, value, base: config.baseUrl ?? config.pathsBase ?? root });
    }
  }
  return aliases;
}
export function importBase(root, file, item) {
  const s = item.specifier;
  if (item.python) {
    const dots = s.match(/^\.+/)?.[0].length ?? 0;
    return dots ? path.resolve(path.dirname(file), ...Array(dots - 1).fill('..'), s.slice(dots).replaceAll('.', '/')) : path.resolve(root, s.replaceAll('.', '/'));
  }
  if (s.startsWith('file://')) return fileURLToPath(s);
  if (s.startsWith('.')) return path.resolve(path.dirname(file), s);
  if (s.startsWith('/')) return path.resolve(root, s.slice(1));
  if (s.startsWith('src/') || s.startsWith('@/') || s.startsWith('~/')) return path.resolve(root, s.replace(/^[@~]\//, 'src/'));
  return null;
}
export function resolveImport(base, python = false) {
  if (!base) return null;
  const candidates = python ? [base + '.py', path.join(base, '__init__.py')] : [base, ...['.mjs', '.js', '.ts', '.tsx', '.jsx', '.cjs', '.json'].map(e => base + e), ...['.mjs', '.js', '.ts', '.cjs'].map(e => path.join(base, 'index' + e))];
  if (!python && base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts');
  return candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
}
