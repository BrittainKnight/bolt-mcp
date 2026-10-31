"""Standalone JSON boundary and isolated vendor execution."""
import contextlib
import importlib
import importlib.util
import json
import math
import os
import signal
from pathlib import Path
import subprocess
import sys
import threading
import time


def validate(value, schema, location='$', normalize=False):
    kind = schema['type']
    valid = {'object': isinstance(value, dict), 'array': isinstance(value, list),
             'string': isinstance(value, str), 'number': type(value) in (int, float),
             'integer': type(value) in (int, float) and math.isfinite(value) and int(value) == value,
             'boolean': type(value) is bool, 'null': value is None}[kind]
    if not valid:
        raise ValueError(f'{location}: expected {kind}')
    if 'enum' in schema and not any(json.dumps(value, sort_keys=True) == json.dumps(item, sort_keys=True) for item in schema['enum']):
        raise ValueError(f'{location}: outside enum')
    if kind in ('integer', 'number'):
        if not math.isfinite(value) or value < schema.get('minimum', -math.inf) or value > schema.get('maximum', math.inf):
            raise ValueError(f'{location}: outside numeric range')
    if kind == 'string' and not schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', math.inf):
        raise ValueError(f'{location}: outside string length')
    if kind == 'array':
        if not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', math.inf):
            raise ValueError(f'{location}: outside array length')
        return [validate(item, schema['items'], f'{location}[{i}]', normalize) for i, item in enumerate(value)]
    if kind == 'object':
        for key in schema.get('required', []):
            if key not in value:
                raise ValueError(f'{location}.{key}: required')
        if not normalize and any(key not in schema['properties'] for key in value):
            raise ValueError(f'{location}: unexpected property')
        return {key: validate(value[key], sub, f'{location}.{key}', normalize)
                for key, sub in schema['properties'].items() if key in value}
    return value


def invoke(entry, export_name, payload, timeout_ms, vendor_root, options=None):
    context_arg = next((arg for arg in sys.argv if arg.startswith('--bolt-context=')), None)
    context = json.loads(context_arg.split('=', 1)[1]) if context_arg else {}
    options = options or {}
    if context.get('sandboxMode') == 'node-permission' or options.get('sandboxMode') == 'node-permission':
        raise ValueError('node-permission mode does not support Python')
    allowed = options.get('allowedEnvKeys', context.get('allowedEnvKeys', []))
    if not isinstance(allowed, list) or any(not isinstance(key, str) or not key.isascii() or not key.isidentifier() for key in allowed):
        raise ValueError('allowedEnvKeys must be environment variable names')
    env = {key: os.environ[key] for key in ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', *allowed]
           if key in os.environ and key != 'NODE_TEST_CONTEXT'}
    env.update(NODE_ENV='test', PYTHONDONTWRITEBYTECODE='1')
    detached = not context.get('managedGroup') and os.name != 'nt'
    process = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '--bolt-worker'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=env, start_new_session=detached)
    try:
        stdout, stderr = process.communicate(json.dumps({'entry': str(entry), 'export': export_name,
                                                         'input': payload, 'root': str(vendor_root), 'parent_pid': os.getpid(), 'own_group': detached}),
                                             timeout=timeout_ms / 1000)
    finally:
        try:
            if detached:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            process.poll()  # Collect the already-exited worker status.
        process.wait()
    if process.returncode != 0:
        raise RuntimeError(stderr[-4000:] or 'Vendor process failed')
    message = json.loads(stdout)
    if not message['ok']:
        raise RuntimeError(message['error'])
    return message['value']


if __name__ == '__main__' and sys.argv[1:] == ['--bolt-worker']:
    request = json.load(sys.stdin)

    def watch_parent():
        while os.getppid() == request['parent_pid']:
            time.sleep(0.05)
        if request['own_group']:
            os.killpg(os.getpid(), signal.SIGKILL)
        else:
            os._exit(1)

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        entry = Path(request['entry'])
        root = Path(request['root'])
        sys.path.insert(0, str(root))
        sys.path.insert(0, str(entry.parent))
        with contextlib.redirect_stdout(sys.stderr):
            module_name = '.'.join(entry.relative_to(root).with_suffix('').parts)
            module = importlib.import_module(module_name)
            value = getattr(module, request['export'])(request['input'])
            if hasattr(value, '__await__'):
                import asyncio
                value = asyncio.run(value)
        print(json.dumps({'ok': True, 'value': value}, allow_nan=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
