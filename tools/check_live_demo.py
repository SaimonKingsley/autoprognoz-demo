"""Check deployed Pages configuration and exact public release, without credentials in logs."""
import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path

BASE = 'https://saimonkingsley.github.io/autoprognoz-demo/'


def fetch(url, token=None):
    headers = {'User-Agent': 'autoprognoz-availability-check', 'Cache-Control': 'no-cache'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=15) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise ValueError('Response exceeds size limit')
                return raw
        except (OSError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2)


def check(root, fetcher=fetch, token=None, sleeper=time.sleep):
    expected = json.loads((Path(root) / 'release.json').read_text(encoding='utf-8'))
    for attempt in range(7):
        pages = json.loads(fetcher('https://api.github.com/repos/SaimonKingsley/autoprognoz-demo/pages', token))
        if pages.get('status') != 'building' or attempt == 6:
            break
        sleeper(10)
    if pages.get('status') != 'built' or pages.get('https_enforced') is not True:
        raise ValueError('Pages must be built with HTTPS enforced')
    deployed = json.loads(fetcher(BASE + 'release.json'))
    if deployed != expected:
        raise ValueError('Deployed release differs from the checked-out public release')
    for name, entry in expected['files'].items():
        # Local release passes check_demo.py before this network check.
        raw = fetcher(BASE + name)
        if len(raw) != entry['bytes'] or hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise ValueError('Published asset mismatch: ' + name)
    print('PASS: Pages built, HTTPS enforced, release ' + expected['release_id'] + ', all assets match')


if __name__ == '__main__':
    check('.', token=os.environ.get('GH_TOKEN'))
