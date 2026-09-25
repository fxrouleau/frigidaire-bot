#!/usr/bin/env python3
"""End-to-end smoke test for a running sandbox container (stdlib only; CI runs it against the built image).

    python3 sandbox/smoke_test.py http://127.0.0.1:8080 --token <SANDBOX_TOKEN> [--hardened]

--hardened additionally asserts the compose hardening (read-only root filesystem, no capabilities).
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any


class Sandbox:
    def __init__(self, base_url: str, token: str | None) -> None:
        self.base_url = base_url.rstrip('/')
        self.token = token

    def request(
        self, method: str, path: str, body: dict[str, Any] | None = None, token: str | None = None
    ) -> tuple[int, Any]:
        headers = {'Content-Type': 'application/json'}
        bearer = token if token is not None else self.token
        if bearer:
            headers['Authorization'] = f'Bearer {bearer}'
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b'{}')

    def run(
        self, language: str, code: str, timeout_seconds: int | None = None, reset_workspace: bool = False
    ) -> dict[str, Any]:
        body: dict[str, Any] = {'language': language, 'code': code}
        if timeout_seconds is not None:
            body['timeout_seconds'] = timeout_seconds
        if reset_workspace:
            body['reset_workspace'] = True
        status, payload = self.request('POST', '/run', body)
        if status != 200 or not isinstance(payload, dict):
            raise AssertionError(f'/run returned HTTP {status}: {payload}')
        return payload


def wait_healthy(sandbox: Sandbox, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    last: object = None
    while time.monotonic() < deadline:
        try:
            status, payload = sandbox.request('GET', '/health')
            if status == 200 and payload.get('ok'):
                return
            last = payload
        except OSError as error:
            last = error
        time.sleep(0.5)
    raise AssertionError(f'sandbox never became healthy: {last}')


def expect(condition: bool, message: str, result: dict[str, Any] | None = None) -> None:
    if not condition:
        detail = f'\n{json.dumps(result, indent=2)[:3000]}' if result is not None else ''
        raise AssertionError(message + detail)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--token')
    parser.add_argument('--hardened', action='store_true')
    args = parser.parse_args()
    sandbox = Sandbox(args.url, args.token)

    def python_stack() -> None:
        code = (
            'import numpy as np, pandas as pd, sympy, requests, matplotlib.pyplot as plt\n'
            "df = pd.DataFrame({'x': np.arange(5), 'y': np.arange(5) ** 2})\n"
            "fig, ax = plt.subplots(); ax.plot(df.x, df.y); fig.savefig('out/chart.png')\n"
            "print(int(df.y.sum()), sympy.factor(sympy.Symbol('x')**2 - 1))\n"
        )
        result = sandbox.run('python', code, timeout_seconds=60)
        expect(result['exit_code'] == 0, 'python stack run failed', result)
        expect(result['stdout'].strip() == '30 (x - 1)*(x + 1)', 'unexpected python output', result)
        names = [f['name'] for f in result['files']]
        expect(names == ['chart.png'], 'chart.png was not returned', result)
        png = base64.b64decode(result['files'][0]['content_base64'])
        expect(png.startswith(b'\x89PNG'), 'chart.png is not a PNG')

    def bash_tools() -> None:
        code = 'echo $((6 * 7)); echo "2+3" | bc; echo \'{"a": 1}\' | jq .a; curl --version >/dev/null && echo curl-ok'
        result = sandbox.run('bash', code)
        expect(result['stdout'].split() == ['42', '5', '1', 'curl-ok'], 'bash tools missing', result)

    def node_runs() -> None:
        result = sandbox.run('node', 'const x = await Promise.resolve(21); console.log(x * 2, typeof fetch)')
        expect(result['stdout'].strip() == '42 function', 'node run failed', result)

    def identity_and_env() -> None:
        code = (
            'id -u; echo "tz=$TZ"; env | grep -c SANDBOX_ || true; '
            'cat /proc/$PPID/environ >/dev/null 2>&1 && echo leak || echo sealed'
        )
        result = sandbox.run('bash', code)
        lines = result['stdout'].split()
        expect(lines[0] == '10001', 'runs should execute as uid 10001', result)
        expect(lines[1] == 'tz=America/New_York', 'TZ should be Eastern', result)
        expect(lines[2] == '0', 'SANDBOX_* variables leaked into the run environment', result)
        expect(lines[3] == 'sealed', "the server's environment is readable from a run", result)

    def run_cannot_start_runs() -> None:
        # A run can read the token from tini's environment (PID 1), so the refusal must not depend on it:
        # /run turns away every client on the container's own addresses.
        code = (
            "token=$(tr '\\0' '\\n' < /proc/1/environ 2>/dev/null | sed -n 's/^SANDBOX_TOKEN=//p'); "
            'for host in 127.0.0.1 $(hostname -i); do '
            'curl -s -o /dev/null -w "%{http_code}\\n" -X POST -H "Authorization: Bearer $token" '
            '-H "Content-Type: application/json" --data \'{"language":"bash","code":"touch chained"}\' '
            '"http://$host:8080/run"; done; ls chained 2>/dev/null || echo no-chained-run'
        )
        result = sandbox.run('bash', code)
        lines = result['stdout'].split()
        expect(len(lines) >= 3 and set(lines[:-1]) == {'403'}, 'a run could call /run on its own sandbox', result)
        expect(lines[-1] == 'no-chained-run', 'a run started another run', result)

    def workspace_persists() -> None:
        sandbox.run('bash', 'echo kept > note.txt')
        result = sandbox.run('python', "print(open('note.txt').read().strip())")
        expect(result['stdout'].strip() == 'kept', 'workspace files did not persist', result)

    def planted_files_do_not_shadow() -> None:
        # What one run leaves in the workspace must not change the tools later runs use.
        sandbox.run(
            'bash',
            'echo \'print("HIJACKED")\' > json.py; mkdir -p .local/bin;'
            " printf '#!/bin/sh\\necho HIJACKED\\n' > .local/bin/jq; chmod +x .local/bin/jq",
        )
        python = sandbox.run('python', 'import json; print(json.dumps([1]))')
        expect(python['stdout'].strip() == '[1]', 'a workspace json.py shadowed the stdlib', python)
        nested = sandbox.run('bash', "python3 -c 'import json; print(json.dumps([2]))'; echo '{\"a\": 3}' | jq .a")
        expect(nested['stdout'].split() == ['[2]', '3'], 'a workspace file shadowed a system tool', nested)
        sandbox.run('bash', 'rm -rf json.py .local/bin/jq')

    def reset_workspace_wipes() -> None:
        sandbox.run('bash', 'mkdir -p junk/locked; echo x > junk/locked/f; chmod 500 junk/locked; echo y > .hidden')
        result = sandbox.run('bash', 'ls -A', reset_workspace=True)
        expect(result.get('workspace_reset') is True, 'the sandbox did not report the reset', result)
        expect(result['stdout'].split() == ['out'], 'reset_workspace left files behind', result)

    def out_is_cleared() -> None:
        sandbox.run('bash', 'echo a > out/a.txt')
        result = sandbox.run('bash', 'ls out | wc -l')
        expect(result['stdout'].strip() == '0' and result['files'] == [], 'out/ was not cleared', result)

    def timeout_kills() -> None:
        result = sandbox.run('bash', 'echo started; sleep 30', timeout_seconds=2)
        expect(result['timed_out'] is True and result['stdout'].strip() == 'started', 'timeout not enforced', result)

    def escaped_process_is_killed() -> None:
        code = 'import subprocess\np = subprocess.Popen(["sleep", "300"], start_new_session=True)\nprint(p.pid)'
        pid = sandbox.run('python', code)['stdout'].strip()
        result = sandbox.run('bash', f'kill -0 {pid} 2>/dev/null && echo alive || echo gone')
        expect(result['stdout'].strip() == 'gone', 'a setsid() background process survived the run', result)

    def memory_limit() -> None:
        result = sandbox.run('python', 'x = bytearray(3 * 1024 ** 3)')
        expect(result['exit_code'] != 0 and 'MemoryError' in result['stderr'], 'memory limit not enforced', result)

    def auth_required() -> None:
        if not args.token:
            return
        status, _ = sandbox.request('POST', '/run', {'language': 'bash', 'code': 'true'}, token='wrong')
        expect(status == 401, f'a wrong token got HTTP {status}')

    def hardening() -> None:
        if not args.hardened:
            return
        code = 'awk \'$2 == "/" { split($4, o, ","); print o[1] }\' /proc/mounts; grep CapBnd /proc/self/status'
        result = sandbox.run('bash', code)
        lines = result['stdout'].splitlines()
        expect(lines[0] == 'ro', 'root filesystem is not mounted read-only', result)
        expect(lines[1].split()[-1] == '0000000000000000', 'capabilities were not dropped', result)

    checks: list[tuple[str, Callable[[], None]]] = [
        ('python stack + chart file', python_stack),
        ('bash tools', bash_tools),
        ('node', node_runs),
        ('identity and environment', identity_and_env),
        ('a run cannot start runs', run_cannot_start_runs),
        ('workspace persists', workspace_persists),
        ('planted files do not shadow stdlib or tools', planted_files_do_not_shadow),
        ('reset_workspace wipes the workspace', reset_workspace_wipes),
        ('out/ cleared per run', out_is_cleared),
        ('timeout', timeout_kills),
        ('escaped process killed', escaped_process_is_killed),
        ('memory limit', memory_limit),
        ('auth', auth_required),
        ('hardening', hardening),
    ]

    wait_healthy(sandbox, 60)
    failures = 0
    for name, check in checks:
        try:
            check()
            print(f'ok    {name}')
        except (AssertionError, OSError, KeyError, IndexError) as error:
            failures += 1
            print(f'FAIL  {name}: {error}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
