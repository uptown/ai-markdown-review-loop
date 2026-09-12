"""Measure JSON transport costs with tiktoken; no model or content logging.

Install tiktoken in an isolated development environment, then run this script.
Default data is a synthetic scaling fixture based on the published example.
--input measures an explicit local sidecar without printing its content.
"""
import argparse
import copy
import json
from pathlib import Path
import re
import tiktoken

parser = argparse.ArgumentParser()
parser.add_argument('--input', type=Path)
parser.add_argument('--output', type=Path)
options = parser.parse_args()
root = Path(__file__).resolve().parent.parent
if options.input:
    payloads = [json.loads(options.input.read_text())]
    fixture = 'Explicit input; content omitted from report'
else:
    template = json.loads(re.search(r'```json\n(.*?)\n```', (root / 'docs/AI-REVIEW-POLICY.md').read_text(), re.S)[1])
    payloads = []
    for count in (1, 10, 100):
        value = copy.deepcopy(template)
        value['items'] = [dict(copy.deepcopy(template['items'][0]), id=f'rv_request_{i:03d}') for i in range(count)]
        # Compare whitespace only; both transports contain the same required context.
        value['context'] = {'workspaceFolder': 'Project', 'path': 'docs/spec.md'}
        payloads.append(value)
    fixture = 'Synthetic scaling fixture based on the canonical published example'
results = []
for encoding_name in ('cl100k_base', 'o200k_base'):
    encoder = tiktoken.get_encoding(encoding_name)
    for payload in payloads:
        pretty = json.dumps(payload, indent=2, ensure_ascii=False) + '\n'
        compact = json.dumps(payload, separators=(',', ':'), ensure_ascii=False)
        assert json.loads(pretty) == json.loads(compact)
        before, after = len(encoder.encode(pretty)), len(encoder.encode(compact))
        results.append({'encoding': encoding_name, 'comments': len(payload['items']), 'prettyTokens': before,
                        'compactTokens': after, 'savedTokens': before - after,
                        'savedPercent': round((before - after) / before * 100, 1)})
report = {'tokenizer': 'tiktoken', 'version': tiktoken.__version__, 'fixture': fixture,
          'scope': 'Whitespace-only transport comparison; not a model-quality or model-specific price claim.', 'results': results}
output = json.dumps(report, indent=2) + '\n'
if options.output:
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(output)
print(output)
