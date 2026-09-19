"""Simulation-only Jev multi-driver command line."""
import argparse
import json
from pathlib import Path
from .policy import browser_contract
from .runtime import run
from .scenarios import author


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    drive = sub.add_parser("run")
    drive.add_argument("--spec", required=True)
    drive.add_argument("--out", required=True)
    drive.add_argument("--seconds", type=float, default=20.0)
    drive.add_argument("--seed", default="jev-multidriver-1")
    drive.add_argument("--actor", action="append")
    scene = sub.add_parser("author")
    scene.add_argument("--out", required=True)
    scene.add_argument("--bad-actor", action="store_true")
    contract = sub.add_parser("contract")
    contract.add_argument("--out")
    service = sub.add_parser("serve")
    service.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    if args.command == "run":
        run(args.spec, args.out, seconds=args.seconds, seed=args.seed, actor_ids=args.actor)
    elif args.command == "author":
        author(args.out, args.bad_actor)
    elif args.command == "serve":
        from .serve import serve
        serve(args.port)
    else:
        text = json.dumps(browser_contract(), indent=2)
        if args.out:
            Path(args.out).write_text(text + "\n")
        else:
            print(text)

if __name__ == "__main__":
    main()
