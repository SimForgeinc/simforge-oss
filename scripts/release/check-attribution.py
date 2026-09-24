#!/usr/bin/env python3
"""Check the licence and attribution of every asset the SDK distributes.

The CLI ships no 3D models itself: `simforge assets pull` fetches a
content-addressed actor closure (`simforge.actor-assets-closure/v1`) and
`maps pull` a map release. What we distribute there must carry, per model, a
licence we accept and, for CC-BY content, what CC BY 4.0 section 3(a) asks
for: the creator credit, the licence and its URL, the source, and whether
(and how) the work was modified.

Inputs (any number of each):
  --catalog-dir DIR   an in-repo catalog: DIR/ATTRIBUTION.json + DIR/manifest.json
                      (both historical shapes: the vehicles' snake_case dict and
                      the pedestrians' camelCase list)
  --closure REF       a closure document: a local path, an https URL, or a
                      digest resolved against --closure-base
                      (<base>/actor-assets/closures/<digest>.json, members at
                      <base>/blobs/sha256/<xx>/<sha256>). The closure's
                      ATTRIBUTION.json member is authoritative; without one,
                      catalog-models.json entries are checked and must carry
                      a licence themselves.

Outputs:
  exit 0 when every model passes; exit 1 with one line per problem otherwise.
  --markdown FILE writes the "Asset attributions" section that
  scripts/release/notices.sh appends to THIRD_PARTY_NOTICES.md.

No fallbacks: a model without a licence is an error, never "assumed CC-BY".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

CLOSURE_SCHEMA = "simforge.actor-assets-closure/v1"
DEFAULT_CLOSURE_BASE = "https://da3tufozhdsvl.cloudfront.net"

# Asset licences we redistribute. Share-alike and non-commercial licences are
# not accepted: they would bind users' renders.
ACCEPTED = {
    "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
    "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
    "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
    "MIT": "https://opensource.org/license/mit",
    "LicenseRef-Public-Domain": "",
}
NEEDS_CREDIT = {"CC-BY-4.0"}


@dataclass
class Asset:
    origin: str
    asset_id: str
    title: str = ""
    license: str | None = None
    license_url: str | None = None
    attribution: str | None = None
    source: str | None = None
    modifications: list[str] = field(default_factory=list)


def _mods(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(v) for v in value if str(v).strip()]


def load_catalog_dir(directory: Path) -> tuple[list[Asset], list[str]]:
    problems: list[str] = []
    attribution_path = directory / "ATTRIBUTION.json"
    manifest_path = directory / "manifest.json"
    if not attribution_path.is_file():
        return [], [f"{directory}: no ATTRIBUTION.json"]
    doc = json.loads(attribution_path.read_text())
    default_license = doc.get("license")
    default_url = doc.get("license_url") or doc.get("licenseUrl")
    default_source = doc.get("source_url") or doc.get("source") or doc.get("catalog")
    raw = doc.get("assets")
    entries: dict[str, dict] = {}
    if isinstance(raw, dict):
        entries = dict(raw)
    elif isinstance(raw, list):
        for item in raw:
            key = item.get("id") or item.get("file")
            if not key:
                problems.append(f"{attribution_path}: an asset entry has neither id nor file")
                continue
            entries[key] = item
    else:
        problems.append(f"{attribution_path}: 'assets' is neither a dict nor a list")

    assets = []
    for key, item in entries.items():
        assets.append(Asset(
            origin=str(attribution_path),
            asset_id=key,
            title=item.get("title", ""),
            license=item.get("license", default_license),
            license_url=item.get("license_url") or item.get("licenseUrl") or default_url,
            attribution=item.get("attribution"),
            source=item.get("source_url") or item.get("source") or item.get("source_packages") and "; ".join(item["source_packages"]) or default_source,
            modifications=_mods(item.get("modifications")),
        ))

    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        listed: set[str] = set()
        for table in ("vehicles", "pedestrians", "models", "assets"):
            if isinstance(manifest.get(table), dict):
                listed |= set(manifest[table])
        missing = sorted(listed - set(entries))
        for asset_id in missing:
            problems.append(f"{manifest_path}: model {asset_id} has no ATTRIBUTION.json entry")
    return assets, problems


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "simforge-release-attribution-check"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def _member(base: str, members: dict, name: str) -> bytes | None:
    member = members.get(name)
    if member is None:
        return None
    sha = member["sha256"]
    body = _fetch(f"{base}/blobs/sha256/{sha[:2]}/{sha}")
    if hashlib.sha256(body).hexdigest() != sha:
        raise SystemExit(f"closure member {name}: sha256 mismatch (expected {sha})")
    return body


def load_closure(ref: str, base: str) -> tuple[list[Asset], list[str]]:
    base = base.rstrip("/")
    if Path(ref).is_file():
        body = Path(ref).read_bytes()
    elif ref.startswith("https://"):
        body = _fetch(ref)
    else:
        body = _fetch(f"{base}/actor-assets/closures/{ref}.json")
        if hashlib.sha256(body).hexdigest() != ref:
            raise SystemExit(f"closure {ref}: document sha256 mismatch")
    doc = json.loads(body)
    origin = f"closure {hashlib.sha256(body).hexdigest()[:12]}"
    if doc.get("schema") != CLOSURE_SCHEMA:
        return [], [f"{origin}: schema is {doc.get('schema')!r}, expected {CLOSURE_SCHEMA}"]
    members = doc.get("members") or {}
    problems: list[str] = []

    attribution = _member(base, members, "ATTRIBUTION.json")
    catalog = _member(base, members, "catalog-models.json")
    catalog_doc = json.loads(catalog) if catalog else {}

    if attribution is None:
        problems.append(f"{origin}: no ATTRIBUTION.json member (the closure must ship its attribution; PLAN §4.3)")
        assets = []
        for key, entry in catalog_doc.items():
            model = entry.get("model", {})
            assets.append(Asset(
                origin=f"{origin} catalog-models.json",
                asset_id=key,
                license=model.get("license") or entry.get("license"),
                license_url=model.get("licenseUrl") or entry.get("licenseUrl"),
                attribution=model.get("attribution"),
                source=model.get("source"),
                modifications=_mods(model.get("modifications")),
            ))
        return assets, problems

    with tempfile.TemporaryDirectory() as scratch:
        tmp = Path(scratch)
        (tmp / "ATTRIBUTION.json").write_bytes(attribution)
        assets, dir_problems = load_catalog_dir(tmp)
    for asset in assets:
        asset.origin = f"{origin} ATTRIBUTION.json"
    problems += [p.replace(str(tmp), origin) for p in dir_problems]
    missing = sorted(set(catalog_doc) - {a.asset_id for a in assets})
    for asset_id in missing:
        problems.append(f"{origin}: catalog model {asset_id} has no ATTRIBUTION.json entry")
    return assets, problems


def check(asset: Asset) -> list[str]:
    where = f"{asset.origin}: {asset.asset_id}"
    if not asset.license:
        return [f"{where}: no licence"]
    if asset.license not in ACCEPTED:
        return [f"{where}: licence {asset.license} is not accepted for redistribution"]
    problems = []
    if asset.license in NEEDS_CREDIT:
        if not (asset.attribution and asset.attribution.strip()):
            problems.append(f"{where}: {asset.license} needs an attribution (creator credit)")
        if not asset.license_url:
            problems.append(f"{where}: {asset.license} needs the licence URL")
        if not asset.source:
            problems.append(f"{where}: {asset.license} needs the source")
        if not asset.modifications:
            problems.append(f"{where}: {asset.license} needs the modifications (or an explicit 'unmodified')")
    return problems


def markdown(assets: list[Asset]) -> str:
    lines = [
        "## Asset attributions",
        "",
        "The CLI downloads these models on `simforge assets pull`; each closure",
        "carries the same record as `ATTRIBUTION.json`, and the CLI prints its path.",
        "",
    ]
    by_origin: dict[str, list[Asset]] = {}
    for asset in assets:
        by_origin.setdefault(asset.origin, []).append(asset)
    for origin in sorted(by_origin):
        lines += [f"### {origin}", ""]
        for asset in sorted(by_origin[origin], key=lambda a: a.asset_id):
            url = asset.license_url or ACCEPTED.get(asset.license or "", "")
            lic = f"[{asset.license}]({url})" if url else str(asset.license)
            lines.append(f"- `{asset.asset_id}`: {asset.attribution or asset.title} Licence: {lic}.")
            if asset.modifications:
                lines.append(f"  Modifications: {'; '.join(asset.modifications)}.")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog-dir", action="append", default=[], type=Path)
    parser.add_argument("--closure", action="append", default=[])
    parser.add_argument("--closure-base", default=DEFAULT_CLOSURE_BASE)
    parser.add_argument("--markdown", type=Path)
    args = parser.parse_args()
    if not args.catalog_dir and not args.closure:
        parser.error("nothing to check: pass --catalog-dir and/or --closure")

    assets: list[Asset] = []
    problems: list[str] = []
    for directory in args.catalog_dir:
        found, issues = load_catalog_dir(directory)
        assets += found
        problems += issues
    for ref in args.closure:
        found, issues = load_closure(ref, args.closure_base)
        assets += found
        problems += issues
    for asset in assets:
        problems += check(asset)

    if args.markdown:
        args.markdown.write_text(markdown(assets))
    licences: dict[str, int] = {}
    for asset in assets:
        licences[str(asset.license)] = licences.get(str(asset.license), 0) + 1
    summary = {"assets": len(assets), "licences": licences, "problems": len(problems)}
    for problem in problems:
        print(problem, file=sys.stderr)
    print(json.dumps(summary))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
