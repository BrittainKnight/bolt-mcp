from helper import twice


def execute(payload):
    return {'result': twice(payload['value']), 'internal': 'vendor-only'}
