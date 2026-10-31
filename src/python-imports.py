"""Parse Python source without importing or executing the inspected module."""
import ast
import json
import sys

request = json.load(sys.stdin)
found = []


def add(specifier, node, **details):
    found.append({'specifier': specifier, 'line': node.lineno, 'python': True, **details})


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return dotted(node.value) + '.' + node.attr
    return ''


try:
    tree = ast.parse(request['source'])
    modules = {'importlib'}
    loaders = {'__import__'}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for name in node.names:
                add(name.name, node)
                if name.name == 'importlib':
                    modules.add(name.asname or name.name)
        elif isinstance(node, ast.ImportFrom):
            base = '.' * node.level + (node.module or '')
            add(base, node)
            for name in node.names:
                if name.name != '*':
                    add(base + ('.' if node.module else '') + name.name, node, member=True)
                if not node.level and node.module == 'importlib' and name.name == 'import_module':
                    loaders.add(name.asname or name.name)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = dotted(node.func)
        if name not in loaders and name not in {module + '.import_module' for module in modules}:
            continue
        value = node.args[0] if node.args else next((item.value for item in node.keywords if item.arg == 'name'), None)
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            specifier = value.value
            if name != '__import__' and specifier.startswith('.'):
                package = node.args[1] if len(node.args) > 1 else next((item.value for item in node.keywords if item.arg == 'package'), None)
                if isinstance(package, ast.Constant) and isinstance(package.value, str):
                    level = len(specifier) - len(specifier.lstrip('.'))
                    parts = package.value.split('.')
                    if level > len(parts):
                        add(None, node, error='Dynamic relative import escapes its package')
                        continue
                    specifier = '.'.join(parts[:len(parts) - level + 1] + [specifier.lstrip('.')]).rstrip('.')
                else:
                    add(None, node, error='Dynamic relative import requires a literal package')
                    continue
            add(specifier, node)
        else:
            add(None, node, error='Computed Python import requires a literal module name')
except SyntaxError as error:
    found.append({'specifier': None, 'python': True, 'line': error.lineno or 1,
                  'error': 'Python syntax error: ' + error.msg})
print(json.dumps(found))
