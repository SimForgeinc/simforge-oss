"""Caller-clocked driving on `simforge-render serve`'s existing socket/shm protocol.

Run `python -m simforge_render.closed_loop --help`. Model integrations implement
simforge_render.policy.DrivingPolicy, returning its canonical BicycleAction. No fake model,
job queue, transport shim or policy-dependent simulation clock is involved.

The render look is fixed when the service starts, not per camera: closed-loop
training runs `simforge-render serve --scene S --socket E --preset training`
(equivalently `render: {"preset": "training"}` in the scene spec).
"""
from __future__ import annotations
import argparse
from dataclasses import asdict
import hashlib
import importlib
import json
from pathlib import Path
import time
import numpy as np
from .client import NativeRenderClient
from . import policy as policy_api
from .observation import ObservationAdapter, PolicyObservation




def fingerprint(observation: PolicyObservation) -> str:
    """Bind a recorded action to observable bytes, never to a magnitude/range."""
    digest=hashlib.sha256()
    digest.update(json.dumps({'time':observation.time_seconds,'ego':observation.ego_history,
                              'metadata':observation.metadata},sort_keys=True,allow_nan=False).encode())
    for name,history in sorted(observation.camera_history.items()):
        digest.update(name.encode())
        for image in history: digest.update(image or b'<missing>')
    for name, pair in sorted(observation.dense_pinhole.items()):
        digest.update(name.encode());digest.update(pair[0].tobytes());digest.update(pair[1].tobytes())
    for name, pair in sorted(observation.sparse_ftheta.items()):
        digest.update(name.encode());digest.update(pair[0].tobytes());digest.update(pair[1].tobytes())
    for name, products in sorted(observation.lidar.items()):
        digest.update(name.encode())
        for key,value in sorted(products.items()):
            digest.update(key.encode())
            digest.update(value.tobytes() if isinstance(value,np.ndarray) else json.dumps(value).encode())
    return digest.hexdigest()


class RecordedPairPolicy:
    """Strict interface qualification, NOT learned inference.

    Every action must have a matching recorded observation fingerprint. An
    unseen observation is an error, not a stub/default action fallback.
    """
    def __init__(self, pairs: Path):
        records=json.loads(pairs.read_text())
        self.actions={row['observationSha256']:policy_api.BicycleAction(**row['action']) for row in records}

    def infer(self, observation: PolicyObservation) -> policy_api.BicycleAction:
        key=fingerprint(observation)
        if key not in self.actions:
            raise ValueError(f'no recorded action for observation {key}; no model inference claimed')
        return self.actions[key]


def write_observation(out: Path, number: int, observation: PolicyObservation) -> None:
    directory=out/f'observation-{number:05d}';directory.mkdir()
    metadata={'timeSeconds':observation.time_seconds,'egoHistory':observation.ego_history,
              'metadata':observation.metadata,'sha256':fingerprint(observation),'cameras':{}}
    for index,(name,history) in enumerate(sorted(observation.camera_history.items())):
        files=[]
        for slot,image in enumerate(history):
            extension='png' if observation.metadata['consumer']['rgb']['kind']=='png' else 'jpg'
            filename=f'camera-{index}-{slot}.{extension}' if image else None
            if image: (directory/filename).write_bytes(image)
            files.append(filename)
        metadata['cameras'][name]=files
    arrays={}
    for label,products in [('dense_pinhole',observation.dense_pinhole),('sparse_ftheta',observation.sparse_ftheta)]:
        for name,(depth,valid) in products.items():
            arrays[f'{label}/{name}/depth']=depth;arrays[f'{label}/{name}/valid']=valid
    for name,products in observation.lidar.items():
        for key,value in products.items():arrays[f'lidar/{name}/{key}']=np.asarray(value)
    np.savez_compressed(directory/'targets.npz',**arrays)
    (directory/'observation.json').write_text(json.dumps(metadata,indent=2,allow_nan=False))


def read_observation(directory: Path) -> PolicyObservation:
    """Load a recorded policy sample and verify its full byte-bound fingerprint."""
    data=json.loads((directory/'observation.json').read_text())
    cameras={name:[(directory/file).read_bytes() if file else None for file in files]
             for name,files in data['cameras'].items()}
    dense,sparse,lidar={},{},{}
    with np.load(directory/'targets.npz',allow_pickle=False) as arrays:
        for key in arrays.files:
            kind,name,product=key.split('/',2)
            value=arrays[key]
            if kind=='lidar':
                lidar.setdefault(name,{})[product]=value.item() if product=='ground_plane_fitted' else value
            else:
                target=dense if kind=='dense_pinhole' else sparse
                target.setdefault(name,{})[product]=value
    observation=PolicyObservation(data['timeSeconds'],cameras,
        {k:(v['depth'],v['valid']) for k,v in dense.items()},
        {k:(v['depth'],v['valid']) for k,v in sparse.items()},lidar,data['egoHistory'],data['metadata'])
    if fingerprint(observation)!=data['sha256']:raise ValueError('recorded observation fingerprint mismatch')
    return observation


def distribution(values: list[float]) -> dict:
    return {name:float(np.percentile(values,percentile)) for name,percentile in
            [('min',0),('p50',50),('p90',90),('p95',95),('p99',99),('max',100)]} if values else {}


def run(client: NativeRenderClient, scenario: dict, rig: dict, policy: policy_api.DrivingPolicy, out: Path,
        *, timeout_seconds: float = 20, realtime: bool = False, record_pairs: bool = False,
        consumer: dict | None = None) -> dict:
    if out.exists() and any(out.iterdir()):raise ValueError('closed-loop output directory must be empty')
    out.mkdir(parents=True,exist_ok=True)
    ego_id=rig['egoId'];vehicle=next(a for a in scenario['actors'] if a['id']==ego_id)['dims']
    adapter=ObservationAdapter(rig['cameras'],rig['lidars'],vehicle,rig.get('ftheta'))
    t0=time.perf_counter()
    response=client.reset_episode(scenario,ego_id,rig['cameras'],rig['lidars'],
        {'wheelbaseM':rig.get('wheelbaseM',2.7),'timeoutSeconds':timeout_seconds,'goalRadiusM':rig.get('goalRadiusM',1.)},consumer)
    observation=adapter.adapt(client,response)
    reset_ms=(time.perf_counter()-t0)*1000
    write_observation(out,0,observation)
    rows=[];pairs=[]
    while response['observation']['termination'] is None:
        begin=time.perf_counter();action=policy.infer(observation);policy_ms=(time.perf_counter()-begin)*1000
        if not isinstance(action,policy_api.BicycleAction):raise TypeError('DrivingPolicy must return BicycleAction')
        if record_pairs:pairs.append({'observationSha256':fingerprint(observation),'action':asdict(action),
                                      'source':'recorded interface action; not a learned-model claim'})
        rpc_start=time.perf_counter();response=client.step_episode(action.wire());rpc_ms=(time.perf_counter()-rpc_start)*1000
        adapter_start=time.perf_counter();observation=adapter.adapt(client,response);adapter_ms=(time.perf_counter()-adapter_start)*1000
        step_ms=(time.perf_counter()-begin)*1000
        rows.append({'step':len(rows)+1,'timeSeconds':observation.time_seconds,'policyMs':policy_ms,
                     'rpcMs':rpc_ms,'adapterMs':adapter_ms,'stepMs':step_ms,'serverMs':response['server_ms'],
                     'action':asdict(action),'state':response['observation']})
        write_observation(out,len(rows),observation)
        if realtime and response['observation']['termination'] is None:
            time.sleep(max(0,1/response['consumer']['cameraHz']-(time.perf_counter()-begin)))
    if record_pairs:(out/'recorded-pairs.json').write_text(json.dumps(pairs,indent=2))
    final=response['observation']
    result={'schema':'simforge.closed-loop-run.v1','policy':type(policy).__name__,'resetMs':reset_ms,
            'consumer':response['consumer'],'timingScope':'policy + synchronous RPC/render + observation adaptation; excludes artifact writes and deliberate pacing',
            'stepDistributionMs':distribution([r['stepMs'] for r in rows]),
            'rpcDistributionMs':distribution([r['rpcMs'] for r in rows]),
            'stepBudgetMs':1000/response['consumer']['cameraHz'],
            'overBudget':sum(r['stepMs']>1000/response['consumer']['cameraHz'] for r in rows),
            'over500ms':sum(r['stepMs']>500 for r in rows),'steps':rows,'termination':final['termination'],
            'score':final['score'],'scoreValid':final['scoreValid'],'progress':final['progress']}
    (out/'run.json').write_text(json.dumps(result,indent=2,allow_nan=False))
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description='Closed-loop policy runner: existing `simforge-render serve` v5 socket + shared memory.',
        epilog='Start the service with `simforge-render serve --scene S --socket E --preset training`: the look is one RenderConfig fixed at serve time, not a per-camera setting. SceneApp uses model catalogs. Replay divergence is terminal, not a policy collision.')
    parser.add_argument('--socket',required=True);parser.add_argument('--scenario',type=Path,required=True)
    parser.add_argument('--rig',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--policy',default='fixed-arc',help='fixed-arc, recorded, or module:factory returning DrivingPolicy (real model hook)')
    parser.add_argument('--pairs',type=Path);parser.add_argument('--steering-rad',type=float,default=.02)
    parser.add_argument('--acceleration-mps2',type=float,default=0.)
    parser.add_argument('--timeout-seconds',type=float,default=20.);parser.add_argument('--realtime',action='store_true')
    parser.add_argument('--record-pairs',action='store_true');parser.add_argument('--product-spec',type=Path)
    args=parser.parse_args(argv)
    if args.policy=='fixed-arc':policy=policy_api.FixedArcPolicy(args.steering_rad,args.acceleration_mps2)
    elif args.policy=='recorded':
        if args.pairs is None:parser.error('--policy recorded requires --pairs')
        policy=RecordedPairPolicy(args.pairs)
    else:
        module,name=args.policy.split(':',1);policy=getattr(importlib.import_module(module),name)()
    client=NativeRenderClient(args.socket)
    try:
        result=run(client,json.loads(args.scenario.read_text()),json.loads(args.rig.read_text()),policy,args.out,
                   timeout_seconds=args.timeout_seconds,realtime=args.realtime,record_pairs=args.record_pairs,
                   consumer=json.loads(args.product_spec.read_text()) if args.product_spec else None)
        print(json.dumps({k:v for k,v in result.items() if k!='steps'},indent=2))
    finally:client.close()

if __name__=='__main__':main()
