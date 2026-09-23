"""One trainer entrypoint: frozen configs in, registered checkpoints out."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import yaml

from .config import provenance


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--recipe', required=True, choices=['ppo-teacher', 'distill-student'])
    parser.add_argument('--config', type=Path)
    parser.add_argument('--split', help='train split manifest path, or a frozen PoC split name (e.g. train)')
    parser.add_argument('--max-decisions', type=int)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--device')
    args = parser.parse_args(argv)
    config_path = (args.config or Path(__file__).parent / 'configs' / ('poc.yaml' if args.recipe == 'ppo-teacher' else 'distill-student.yaml')).expanduser().resolve()
    config = yaml.safe_load(config_path.read_text())
    if not isinstance(config, dict) or config.get('schema') != 'simforge.train/v1':
        parser.error('config must be a simforge.train/v1 YAML/JSON document')
    if config.get('recipe', args.recipe) != args.recipe:
        parser.error('config recipe differs from --recipe')
    unknown = set(config) - {'schema', 'recipe', 'out', 'train', 'val', 'splitManifests', 'options', 'dataset'}
    if unknown:
        parser.error(f'unknown config keys: {sorted(unknown)}')
    def resolve(value: str) -> str:
        p = Path(value).expanduser()
        return str((config_path.parent / p).resolve() if not p.is_absolute() else p.resolve())
    if not args.out and 'out' not in config:
        parser.error('provide config.out or --out')
    out = args.out.expanduser().resolve() if args.out else Path(resolve(config['out']))
    options = dict(config.get('options', {}))
    if args.device:
        options['device'] = args.device
    if args.max_decisions is not None:
        if args.max_decisions < 1:
            parser.error('--max-decisions must be positive')
        options['max_env_steps' if args.recipe == 'ppo-teacher' else 'max_frames'] = args.max_decisions
    splits = {name: resolve(config[name]) for name in ('train', 'val') if name in config}
    manifests = {name: resolve(value) for name, value in config.get('splitManifests', {}).items()}
    if args.split:
        if args.recipe != 'ppo-teacher':
            parser.error('--split is only valid for ppo-teacher')
        train_manifest = Path(args.split).expanduser()
        if not train_manifest.is_file():
            train_manifest = Path.cwd() / 'qualification/training-splits/poc-v1' / f'{args.split}.split.json'
        for name, manifest in [('train', train_manifest), ('val', train_manifest.with_name('val.split.json'))]:
            document = json.loads(manifest.read_text())
            if document.get('purpose') != name or not document.get('materialization'):
                parser.error(f'{manifest}: expected a materialized {name} split')
            manifests[name] = str(manifest.resolve())
            splits[name] = str((manifest.parent / document['materialization']['episodes']['path']).resolve())
    if args.recipe == 'ppo-teacher' and set(splits) != {'train', 'val'}:
        parser.error('ppo-teacher requires materialized train and val episodes.json paths')
    resolved = {**config, **splits, 'out': str(out), 'options': options, 'splitManifests': manifests}
    config_digest = hashlib.sha256(json.dumps(resolved, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    prov = provenance(splits, manifests)
    out.mkdir(parents=True, exist_ok=True)
    provenance_path = out / 'trainer-provenance.json'
    if (out / 'trainer-config.json').exists() and not options.get('resume'):
        raise FileExistsError(f'{out}: trainer config exists; choose a new run directory or explicitly resume')
    (out / 'trainer-config.json').write_text(json.dumps({**resolved, 'configDigest': config_digest}, indent=2) + '\n')
    provenance_path.write_text(json.dumps(prov, indent=2) + '\n')
    if args.recipe == 'ppo-teacher':
        from .ppo import main as train
        flags = ['--train', splits['train'], '--val', splits['val'], '--out', str(out), '--config-digest', config_digest, '--provenance', str(provenance_path)]
        for key, value in options.items():
            flags.extend(['--' + key.replace('_', '-'), str(value)])
        train(flags)
    else:
        from .distill import train
        dataset = dict(config.get('dataset', {}))
        dataset['runs'] = [resolve(value) for value in dataset.get('runs', [])]
        dataset['labels'] = [{**item, 'path': resolve(item['path'])} for item in dataset.get('labels', [])]
        if 'teacher' in dataset:
            teacher = dataset['teacher']
            dataset['teacher'] = resolve(teacher) if teacher.startswith(('.', '/', '~')) else teacher
        train(out=out, dataset=dataset, options=options, trainer={'recipe': args.recipe, 'configDigest': config_digest}, provenance=prov)


if __name__ == '__main__':
    main()
