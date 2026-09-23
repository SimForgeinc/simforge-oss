"""CleanRL-style PPO over kernel EpisodeBatch; learner may use CUDA."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import random
import signal
import time
from collections import deque
from pathlib import Path

import numpy as np
import torch

from ..episodes import EpisodeSpec, episode_config, load_episode_spec
from ..native import ABI_VERSION, ENGINE_VERSION, REWARD_TERM_NAMES, DEFAULT_REWARD_CONFIG_JSON
from ..vector import SimForgeVectorEnv
from .dashboard import publish, render_dashboard
from .config import provenance as training_provenance
from .model import ACTION_HEAD, OBS_PRESET, Teacher, load_checkpoint, observations, save_checkpoint

DEVIATIONS = [
    'Prototype is a 5.39M DeepSets longitudinal SETPOINT teacher; lateral guidance remains the native authored-route follower, not learned controls.',
    'Actor uses the kernel visible channel; history and lane/route tokens are not implemented. The shared encoder also removes absolute x/y, world heading and route-s.',
    'Reward and safety termination use the native closed-loop contract, including signed authored-route progress, contact, corridor exit, red crossing, comfort, time and queue-aware stuck terms. Corridor exit is not a road-boundary offroad qualification.',
    'Goals are geometric authored-route end or a one-second safe stop at 4.5–6.5 m behind an authored role:queue-tail. Other stopped leaders excuse waiting but never grant a queue goal.',
    'Kernel contact/visibility and Episode trace parity are contract-tested; scenario admission and held-out quality require separate split/campaign receipts. No checkpoint is promoted or safety-qualified.',
    'Bevy bench evaluation uses the same native reward/action semantics; campaign scores and any prologue are separate evidence, not reward-equivalent metrics.',
    'EpisodeBatch is checkpointable; this learner resumes weights/optimizer/counters but explicitly resets native episodes rather than claiming bit-identical training continuation.',
]


def route_lengths(spec: EpisodeSpec) -> np.ndarray:
    lengths = []
    for ep in spec.episodes:
        raw = json.loads(ep.input.to_json())
        ego_id = ep.input.metric_subject or sorted(ep.input.actor_ids)[0]
        actor = next(a for a in raw['actors'] if a['id'] == ego_id)
        route = actor.get('behavior', {}).get('route')
        if not route:
            raise ValueError(f'{ego_id}: no authored geometric route for completion denominator')
        lengths.append(ep.graph.route(json.dumps(route)).length_m)
    return np.asarray(lengths)


def evaluate(model: Teacher, spec: EpisodeSpec, device: torch.device, threads: int) -> dict:
    with SimForgeVectorEnv(episodes=spec.episodes, episode_config_overrides=spec.episode_config, threads=threads, observation_preset="visible") as env:
        obs, _ = env.reset()
        start_s = obs['state_vector'][:, 8].copy()
        denominator = np.maximum(route_lengths(spec) - start_s, 1e-6)
        active = np.ones(env.num_envs, dtype=bool)
        returns = np.zeros(env.num_envs)
        term_totals = np.zeros(len(REWARD_TERM_NAMES), dtype=np.float64)
        collisions = np.zeros(env.num_envs, dtype=bool)
        goals = np.zeros(env.num_envs, dtype=bool)
        completion = np.zeros(env.num_envs)
        decisions = 0
        horizon = max(int(np.ceil((spec.episode_config.get("clipSeconds") or ep.input.clip_seconds) * env.decision_hz)) for ep in spec.episodes)
        if spec.episode_config.get("maxDecisions") is not None:
            horizon = min(horizon, spec.episode_config["maxDecisions"])
        for _ in range(horizon):
            with torch.no_grad():
                action = model.deterministic(*observations(obs['state_vector'], obs['objects'], device)).cpu().numpy()
            obs, reward, terminated, truncated, info = env.step(action)
            collision, goal = info["collision"], info["goal"]
            returns[active] += reward[active]
            term_totals += info["reward_terms"][active].sum(axis=0)
            collisions[active] |= collision[active]
            goals[active] |= goal[active]
            completion[active] = np.clip((obs['state_vector'][active, 8] - start_s[active]) / denominator[active], 0, 1)
            decisions += int(active.sum())
            active &= ~(terminated | truncated)
            if not active.any():
                break
        if active.any():
            raise RuntimeError("kernel episodes exceeded their configured decision horizon")
        return {'episodes': env.num_envs, 'env_steps': decisions, 'episode_return_mean': float(returns.mean()), 'collision_rate': float(collisions.mean()), 'goal_rate': float(goals.mean()), 'route_completion': float(completion.mean()), 'per_episode': [{'return': float(r), 'collision': bool(c), 'route_completion': float(p)} for r, c, p in zip(returns, collisions, completion)],
                **{f"reward_{name}_mean": float(value / decisions) for name, value in zip(REWARD_TERM_NAMES, term_totals, strict=True)}}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--train', required=True)
    parser.add_argument('--val', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--num-envs', type=int, default=0, help='0 uses every materialized training episode')
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--torch-threads', type=int, default=2)
    parser.add_argument('--rollout-steps', type=int, default=64)
    parser.add_argument('--minibatch', type=int, default=1024)
    parser.add_argument('--epochs', type=int, default=4)
    parser.add_argument('--updates', type=int, default=100000)
    parser.add_argument('--hours', type=float, default=6)
    parser.add_argument('--max-env-steps', type=int, default=30_000_000)
    parser.add_argument('--resume', help='checkpoint at the last logged update; native episodes restart, not byte-identical continuation')
    parser.add_argument('--checkpoint-every', type=int, default=20)
    parser.add_argument('--hidden', type=int, default=1024)
    parser.add_argument('--learning-rate', type=float, default=0.0003)
    parser.add_argument('--config-digest')
    parser.add_argument('--provenance')
    args = parser.parse_args(argv)
    provenance = json.loads(Path(args.provenance).read_text()) if args.provenance else training_provenance({'train': args.train, 'val': args.val}, {})
    if args.config_digest is None:
        args.config_digest = hashlib.sha256(json.dumps(vars(args), sort_keys=True).encode()).hexdigest()
    if min(args.rollout_steps, args.epochs, args.minibatch, args.checkpoint_every, args.updates) < 1:
        parser.error('rollout, epochs, minibatch, checkpoint interval and updates must be positive')
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.torch_threads)
    device = torch.device(args.device)
    train = load_episode_spec(args.train)
    val = load_episode_spec(args.val)
    # Resolve from this binary, not a Python duplicate of the kernel constants.
    def teacher_config(spec: EpisodeSpec) -> EpisodeSpec:
        config = dict(spec.episode_config)
        config["reward"] = {**json.loads(DEFAULT_REWARD_CONFIG_JSON), **config.get("reward", {})}
        config.setdefault("goal", {"routeEnd": True, "queueStop": True})
        return EpisodeSpec(spec.episodes, config)
    train, val = teacher_config(train), teacher_config(val)
    if args.num_envs:
        # Deterministic stratification across the ordered frozen compiler grid.
        chosen = np.linspace(0, len(train.episodes) - 1, args.num_envs, dtype=int)
        if len(set(chosen.tolist())) != args.num_envs:
            raise ValueError('num-envs exceeds materialized training episodes')
        train = EpisodeSpec(tuple(train.episodes[i] for i in chosen), train.episode_config)
    if train.episode_config != val.episode_config:
        raise ValueError('train and val must carry the same frozen native episode configuration')
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'metrics.jsonl').exists() and not args.resume:
        raise ValueError(f'{out}/metrics.jsonl exists; refusing to overwrite a run without --resume')
    for sub in ('checkpoints', 'eval-requests', 'dashboards', 'rollouts'):
        (out / sub).mkdir(exist_ok=True)
    model = Teacher(args.hidden).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate, eps=1e-5)
    resumed = {}
    all_rows = []
    resume_history = []
    if args.resume:
        model, payload = load_checkpoint(args.resume, device)
        model.train()
        optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate, eps=1e-5)
        optimizer.load_state_dict(payload['optimizer'])
        torch.set_rng_state(payload['torch_rng'].cpu())
        resumed = payload['metadata']
        all_rows = [json.loads(line) for line in (out / 'metrics.jsonl').read_text().splitlines() if line.strip()]
        if not all_rows or all_rows[-1]['update'] != resumed['update'] or all_rows[-1]['env_steps'] != resumed['env_steps']:
            raise ValueError('resume checkpoint must match the last logged update; never discard newer learning evidence')
        previous_config = json.loads((out / 'run-config.json').read_text())
        expected = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in [('train', args.train), ('val', args.val)]}
        if previous_config['spec_sha256'] != expected:
            raise ValueError('resume scenario split differs from the frozen run')
        resume_history = previous_config.get('resume_history', []) + [{'checkpoint': str(args.resume), 'after_update': resumed['update'], 'native_episodes_reset': True}]
    config = {'args': vars(args), 'host': platform.node(), 'device': str(device), 'cuda_visible_devices': os.environ.get('CUDA_VISIBLE_DEVICES'), 'torch': str(torch.__version__), 'engine_version': ENGINE_VERSION, 'binding_abi': ABI_VERSION, 'parameters': sum(p.numel() for p in model.parameters()), 'obs_preset': OBS_PRESET, 'action_head': ACTION_HEAD, 'native_episode': episode_config(train.episode_config, observation_preset="visible"), 'train_episodes': len(train.episodes), 'val_episodes': len(val.episodes), 'spec_sha256': {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in [('train', args.train), ('val', args.val)]}, 'deviations': DEVIATIONS, 'status': 'learning; NOT promoted'}
    config['resume_history'] = resume_history
    config['reward_term_names'] = list(REWARD_TERM_NAMES)
    (out / 'run-config.json').write_text(json.dumps(config, indent=2) + '\n')
    stop = False
    def request_stop(_signum, _frame):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    began = time.monotonic() - resumed.get('wall_seconds', 0.0)
    recent = deque(maxlen=100)
    global_steps = resumed.get('env_steps', 0)
    native_seconds_total = global_steps / resumed['native_env_steps_per_s'] if resumed else 0.0
    with SimForgeVectorEnv(episodes=train.episodes, episode_config_overrides=train.episode_config, threads=args.threads, observation_preset="visible") as env:
        n, horizon = env.num_envs, args.rollout_steps
        if global_steps + n * horizon > args.max_env_steps:
            raise ValueError('remaining decision budget cannot fit one complete rollout')
        obs, _ = env.reset()
        initial_s = obs['state_vector'][:, 8].copy()
        lengths = route_lengths(train)
        episode_return = np.zeros(n)
        episode_collision = np.zeros(n, dtype=bool)
        episode_goal = np.zeros(n, dtype=bool)
        states = torch.empty((horizon, n, 10), device=device)
        objects = torch.empty((horizon, n, env._batch.max_objects, 5), device=device)
        raw_actions = torch.empty((horizon, n, 2), device=device)
        logprobs = torch.empty((horizon, n), device=device)
        values = torch.empty((horizon, n), device=device)
        rewards = torch.empty((horizon, n), device=device)
        terminateds = torch.empty((horizon, n), dtype=torch.bool, device=device)
        dones = torch.empty_like(terminateds)
        valid = torch.empty_like(terminateds)
        print(f'TRAINER_READY host={platform.node()} device={device} envs={n} parameters={config["parameters"]} out={out}', flush=True)
        last_checkpoint = 0
        with (out / 'metrics.jsonl').open('a', buffering=1) as metrics:
            for update in range(resumed.get('update', 0) + 1, args.updates + 1):
                update_start = time.monotonic()
                update_steps = 0
                update_reward = 0.0
                update_terms = np.zeros(len(REWARD_TERM_NAMES), dtype=np.float64)
                for t in range(horizon):
                    states[t].copy_(torch.from_numpy(obs['state_vector']))
                    objects[t].copy_(torch.from_numpy(obs['objects']))
                    with torch.no_grad():
                        dist, values[t] = model.distribution_value(states[t], objects[t])
                        raw_actions[t] = dist.sample()
                        # PPO ratios in latent Gaussian space are exact: tanh
                        # and affine Jacobians cancel for a fixed sampled action.
                        logprobs[t] = dist.log_prob(raw_actions[t]).sum(-1)
                        action = model.setpoints(raw_actions[t]).cpu().numpy()
                    native_start = time.monotonic()
                    obs, reward, term, trunc, info = env.step(action)
                    native_seconds_total += time.monotonic() - native_start
                    active = ~info["autoreset"]
                    valid[t] = torch.as_tensor(active, device=device)
                    count = int(active.sum())
                    update_steps += count
                    global_steps += count
                    update_reward += float(reward[active].sum())
                    update_terms += info["reward_terms"][active].sum(axis=0)
                    rewards[t] = torch.as_tensor(reward, device=device)
                    terminateds[t] = torch.as_tensor(term, device=device)
                    dones[t] = torch.as_tensor(term | trunc, device=device)
                    collision, goal = info["collision"], info["goal"]
                    episode_return[active] += reward[active]
                    episode_collision[active] |= collision[active]
                    episode_goal[active] |= goal[active]
                    finished = active & (term | trunc)
                    for i in np.flatnonzero(finished):
                        completion = float(np.clip((obs['state_vector'][i, 8] - initial_s[i]) / max(lengths[i] - initial_s[i], 1e-6), 0, 1))
                        recent.append({'return': float(episode_return[i]), 'collision': float(episode_collision[i]), 'goal': float(episode_goal[i]), 'completion': completion})
                    episode_return[finished] = 0
                    episode_collision[finished] = False
                    episode_goal[finished] = False
                    initial_s[info["autoreset"]] = obs['state_vector'][info["autoreset"], 8]
                with torch.no_grad():
                    _, next_value = model.distribution_value(*observations(obs['state_vector'], obs['objects'], device))
                    advantages = torch.zeros_like(rewards)
                    last = torch.zeros(n, device=device)
                    for t in reversed(range(horizon)):
                        bootstrap = next_value if t == horizon - 1 else values[t + 1]
                        # Time limits bootstrap terminal observation; safety/goal
                        # termination does not. Never bootstrap a reset episode.
                        delta = rewards[t] + 0.99 * bootstrap * (~terminateds[t]) - values[t]
                        last = (delta + 0.99 * 0.95 * (~dones[t]) * last) * valid[t]
                        advantages[t] = last
                    returns = advantages + values
                mask = valid.flatten()
                bs = states.flatten(0, 1)[mask]
                bo = objects.flatten(0, 1)[mask]
                ba = raw_actions.flatten(0, 1)[mask]
                bl = logprobs.flatten()[mask]
                badv = advantages.flatten()[mask]
                br = returns.flatten()[mask]
                bv = values.flatten()[mask]
                badv = (badv - badv.mean()) / (badv.std(unbiased=False) + 1e-8)
                approx_kl = 0.0
                for epoch in range(args.epochs):
                    permutation = torch.randperm(len(bs), device=device)
                    for offset in range(0, len(bs), args.minibatch):
                        ids = permutation[offset:offset + args.minibatch]
                        dist, value = model.distribution_value(bs[ids], bo[ids])
                        newlog = dist.log_prob(ba[ids]).sum(-1)
                        logratio = newlog - bl[ids]
                        ratio = logratio.exp()
                        pg = torch.maximum(-badv[ids] * ratio, -badv[ids] * ratio.clamp(0.8, 1.2)).mean()
                        vclip = bv[ids] + (value - bv[ids]).clamp(-0.2, 0.2)
                        vloss = 0.5 * torch.maximum((value - br[ids]).square(), (vclip - br[ids]).square()).mean()
                        entropy = dist.entropy().sum(-1).mean()
                        loss = pg + 0.5 * vloss - 0.001 * entropy
                        if not torch.isfinite(loss):
                            raise FloatingPointError('non-finite PPO objective; refusing to save invalid weights')
                        optimizer.zero_grad(set_to_none=True)
                        loss.backward()
                        torch.nn.utils.clip_grad_norm_(model.parameters(), 0.5)
                        optimizer.step()
                        approx_kl = float(((ratio - 1) - logratio).mean().detach())
                    if approx_kl > 0.03:
                        break
                elapsed = time.monotonic() - began
                row = {'update': update, 'env_steps': global_steps, 'update_env_steps': update_steps, 'reward_mean': update_reward / update_steps, 'episode_return_mean': float(np.mean([r['return'] for r in recent])) if recent else None, 'collision_rate': float(np.mean([r['collision'] for r in recent])) if recent else None, 'goal_rate': float(np.mean([r['goal'] for r in recent])) if recent else None, 'route_completion': float(np.mean([r['completion'] for r in recent])) if recent else None, 'completed_episodes_window': len(recent), 'env_steps_per_s': update_steps / (time.monotonic() - update_start), 'native_env_steps_per_s': global_steps / native_seconds_total, 'wall_seconds': elapsed, 'policy_loss': float(pg.detach()), 'value_loss': float(vloss.detach()), 'approx_kl': approx_kl, 'latent_entropy': float(entropy.detach())}
                row.update({f"reward_{name}_mean": float(value / update_steps)
                            for name, value in zip(REWARD_TERM_NAMES, update_terms, strict=True)})
                all_rows.append(row)
                metrics.write(json.dumps(row, allow_nan=False) + '\n')
                publish(out, all_rows, {'state': 'running', **row, 'host': platform.node(), 'device': str(device)})
                print(json.dumps(row), flush=True)
                final = stop or elapsed >= args.hours * 3600 or update == args.updates or global_steps + n * horizon > args.max_env_steps
                if update == 1 or update % args.checkpoint_every == 0 or final:
                    ckpt = out / 'checkpoints' / f'update-{update:06d}.pt'
                    validation = evaluate(model, val, device, args.threads)
                    receipt = save_checkpoint(ckpt, model, optimizer, {
                        **row, 'seed': args.seed, 'validation': validation,
                        'trainer': {'recipe': 'ppo-teacher', 'configDigest': args.config_digest},
                        'provenance': provenance,
                    })
                    render_dashboard(all_rows, out / 'dashboards' / f'update-{update:06d}.png')
                    request = {'checkpoint': ckpt.name, 'update': update, 'env_steps': global_steps, 'sha256': receipt['sha256'], 'training_metrics': row, 'native_validation': validation, 'status': 'pending GPU-coordinated Bevy evaluation'}
                    target = out / 'eval-requests' / f'update-{update:06d}.json'
                    target.write_text(json.dumps(request, indent=2) + '\n')
                    last_checkpoint = update
                    print(f'CHECKPOINT_READY {ckpt} steps={global_steps} val_return={validation["episode_return_mean"]:.4f} collision={validation["collision_rate"]:.4f}', flush=True)
                if final:
                    publish(out, all_rows, {'state': 'stopped' if stop else 'completed', **row, 'last_checkpoint_update': last_checkpoint})
                    break


if __name__ == '__main__':
    main()
