"""Dependency-free integrity gate for the public synthetic build repository."""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath


def check(root):
    root = Path(root).resolve()
    release = json.loads((root / 'release.json').read_text(encoding='utf-8'))
    assert release['synthetic_only'] is True and release['commercial_use'] is False
    assert re.fullmatch(r'[0-9a-f]{40}', release['source_commit'])
    files = release['files']
    expected = {'index.html', 'styles.css', 'app.mjs', 'domain.mjs', 'snapshot.mjs',
                'data/fixture-v001/manifest.json', 'data/fixture-v001/catalog.json',
                'data/fixture-v001/data/fixture-v001/demo/model.json'}
    assert set(files) == expected, 'Unexpected build assets'
    for name, meta in files.items():
        path = root / name
        assert not path.is_symlink() and path.resolve().is_relative_to(root)
        raw = path.read_bytes()
        assert len(raw) == meta['bytes'] <= 2_000_000, name
        assert hashlib.sha256(raw).hexdigest() == meta['sha256'], name
    assert sum(entry['bytes'] for entry in files.values()) < 1_000_000
    base = root / 'data/fixture-v001'
    manifest = json.loads((base / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['is_fixture'] is True and manifest['status'] == 'fixture'
    assert manifest['sources'] and all(s['rights_status'] == 'synthetic' for s in manifest['sources'])
    for entry in manifest['files']:
        name = entry['path']
        assert not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts and '\\' not in name
        assert 'data/fixture-v001/' + name in files
        raw = (base / name).read_bytes()
        assert len(raw) == entry['bytes']
        assert hashlib.sha256(raw).hexdigest() == entry['sha256']
    print(f"PASS: {release['release_id']}, {len(files)} assets; synthetic fixture and SHA-256 verified")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', nargs='?', default='.')
    check(parser.parse_args().root)
