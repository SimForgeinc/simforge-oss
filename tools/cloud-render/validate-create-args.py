#!/usr/bin/env python3
"""Parse a `vastai create instance ...` argv with vast's own parser, without running it.

This is the strongest dry-run proof available for the create command: vastai
1.5.4's argparse definition (cli/commands/instances.py:201-268) accepts or
rejects the exact argv, and `run_command` is never reached, so no API call is
made and no credit is spent.

Usage (argv starts at the subcommand, i.e. without the `vastai` program name):

    validate-create-args.py create instance 12345 --image repo/img:tag --disk 200 ...

Exits 0 and prints the parsed, load-bearing fields; exits non-zero with the
parser's own error if the command is malformed.
"""

from __future__ import annotations

import sys

try:
    from vastai.cli.main import parser  # type: ignore
    # Commands register themselves with the global parser at import time; main()
    # does this before parse_args, so a standalone parse has to do it too.
    from vastai.cli.commands import register_all_commands  # type: ignore

    register_all_commands(parser)

    # main() adds the global flags after the command modules are imported
    # (vastai/cli/main.py:117-128); --raw lives there, not on the subcommand.
    from vastai.cli.util import api_key_guard, server_url_default  # type: ignore

    parser.add_argument("--url", default=server_url_default)
    parser.add_argument("--retry", type=int, default=3)
    parser.add_argument("--explain", action="store_true")
    parser.add_argument("--raw", action="store_true")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--curl", action="store_true")
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument("--api-key", type=str, default=api_key_guard)
except ImportError as exc:  # pragma: no cover - depends on interpreter choice
    print(f"validate-create-args: vastai package not importable ({exc}).", file=sys.stderr)
    print("Run it with the vastai venv interpreter, e.g.", file=sys.stderr)
    print("  /home/ubuntu/.local/share/pipx/venvs/vastai/bin/python validate-create-args.py ...",
          file=sys.stderr)
    sys.exit(2)

FIELDS = (
    "id", "image", "disk", "env", "login", "label", "onstart", "ssh", "direct",
    "cancel_unavail", "raw", "bid_price", "onstart_cmd", "entrypoint", "args",
)


def main(argv: list[str]) -> int:
    if not argv:
        print("validate-create-args: no argv given", file=sys.stderr)
        return 2
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    name = getattr(func, "__name__", "<none>")
    if name != "create__instance":
        print(f"validate-create-args: argv resolves to {name}, not create__instance",
              file=sys.stderr)
        return 1
    for field in FIELDS:
        if hasattr(args, field):
            print(f"  {field} = {getattr(args, field)!r}")
    # A rental with no bid price is an on-demand instance, which is what we want:
    # an interruptible one can be outbid mid-render.
    if getattr(args, "bid_price", None) is not None:
        print("validate-create-args: bid_price set — this would be an interruptible instance",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
