"""Create a private local recovery snapshot; never commits, pushes, or publishes."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import subprocess
import tarfile

ui = Path(__file__).resolve().parent.parent
code = ui.parent.parent
repos = {'siglum-web': ui, **{name: code / name for name in ['siglum-filesystem', 'siglum-git', 'siglum-engine']}}
out = ui / '.local-release' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
out.mkdir(parents=True, exist_ok=False)
manifest = {'createdAt': datetime.now(timezone.utc).isoformat(), 'published': False, 'repositories': {}, 'files': {}}

def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo)

for name, repo in repos.items():
    files = set(git(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0'))
    archive = out / (name + '-source.tar.gz')
    with tarfile.open(archive, 'w:gz') as tar:
        for relative in sorted(files):
            if not relative:
                continue
            path = repo / relative
            if path.name.startswith('.env') and not path.name.endswith('.example') and path.name != '.env.local-preview':
                continue
            if path.is_file() or path.is_symlink():
                tar.add(path, arcname=name + '/' + relative, recursive=False)
    manifest['repositories'][name] = {
        'path': str(repo), 'head': git(repo, 'rev-parse', 'HEAD').decode().strip(),
        'branch': git(repo, 'branch', '--show-current').decode().strip(),
        'status': git(repo, 'status', '--short').decode().splitlines(),
    }
    if name != 'siglum-web':
        subprocess.run(['bun', 'pm', 'pack', '--ignore-scripts', '--destination', str(out), '--quiet'], cwd=repo, check=True)

engine = repos['siglum-engine']
with tarfile.open(out / 'engine-runtime.tar.gz', 'w:gz') as tar:
    for kind in ['busytex', 'pdftex', 'xetex']:
        for extension in ['js', 'wasm']:
            relative = f'busytex/build/wasm/{kind}.{extension}'
            tar.add(engine / relative, arcname='siglum-engine/' + relative)
    tar.add(engine / 'packages/bundles', arcname='siglum-engine/packages/bundles')
    for archive in sorted((engine / 'busytex/source/texmfrepo/archive').glob('*.tar.xz')):
        if archive.name.split('.r')[0] not in {'fontspec', 'biblatex', 'logreq', 'csquotes', 'etoolbox'}:
            continue
        tar.add(archive, arcname='siglum-engine/' + str(archive.relative_to(engine)))
if (ui / 'app/dist').is_dir():
    with tarfile.open(out / 'site-local-preview.tar.gz', 'w:gz') as tar:
        tar.add(ui / 'app/dist', arcname='dist')
if (ui / '.local-release/site').is_dir():
    with tarfile.open(out / 'site-production-candidate.tar.gz', 'w:gz') as tar:
        tar.add(ui / '.local-release/site', arcname='dist')
current_runtime = engine / '.local-release/current.json'
if current_runtime.exists():
    runtime = json.loads(current_runtime.read_text())
    manifest['runtime'] = json.loads((Path(runtime['directory']) / 'runtime.json').read_text())
for file in sorted(out.iterdir()):
    if file.is_file():
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        manifest['files'][file.name] = {'sha256': digest, 'bytes': file.stat().st_size}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(out / 'README.txt').write_text(
    'Private local Siglum snapshot. Nothing has been published.\n'
    'Source archives include tracked and untracked source, but exclude dependencies, Git metadata, and local environment secrets.\n'
    'Preserve the checkout layout in the project README. Extract engine-runtime.tar.gz into the code directory, then run prepare:local.\n'
    'The website archive is configured for localhost and must not be deployed.\n'
    'Package tarballs are local candidates; release versions and dependencies still require review before publication.\n'
    'This does not back up documents stored inside browser profiles.\n'
)
print(out)
