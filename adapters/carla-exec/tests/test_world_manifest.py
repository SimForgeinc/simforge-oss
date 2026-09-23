from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from simforge_oss_carla_exec import world_manifest
from simforge_oss_carla_exec.runtime import backend as backend_module
from simforge_oss_carla_exec.runtime.backend import CarlaBackend
from simforge_oss_carla_exec.world_manifest_tools import generate, xodr_identity
from simforge_oss_carla_exec.world_manifest_tools.__main__ import main as cli_main

GEO = "+proj=tmerc +lat_0=37.7 +lon_0=-121.9 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"


# -- synthetic OpenDRIVE ----------------------------------------------------------

def road(rid, x, y, hdg, length, *, junction="-1", pred=None, succ=None, signals=(), reverse=False, lanes="right"):
    import math
    if reverse:
        x, y, hdg = x + math.cos(hdg) * length, y + math.sin(hdg) * length, hdg + math.pi
        lanes = "left" if lanes == "right" else "right"
    lane_id = "-1" if lanes == "right" else "1"
    link = ""
    if pred or succ:
        link = "<link>" + (f'<predecessor elementType="road" elementId="{pred[0]}" contactPoint="{pred[1]}"/>' if pred else "") \
            + (f'<successor elementType="road" elementId="{succ[0]}" contactPoint="{succ[1]}"/>' if succ else "") + "</link>"
    sigs = "".join(
        f'<signal id="{sid}" s="{s}" t="{t}" type="1000001" subtype="-1" orientation="+" dynamic="{dyn}" zOffset="0"/>'
        for sid, s, t, dyn in signals
    )
    return (
        f'<road id="{rid}" length="{length}" junction="{junction}">{link}'
        f'<planView><geometry s="0" x="{x}" y="{y}" hdg="{hdg}" length="{length}"><line/></geometry></planView>'
        f'<elevationProfile><elevation s="0" a="10" b="0" c="0" d="0"/></elevationProfile>'
        f'<lanes><laneSection s="0"><{lanes}><lane id="{lane_id}" type="driving" level="false">'
        f'<width sOffset="0" a="3.5" b="0" c="0" d="0"/></lane></{lanes}>'
        f'<center><lane id="0" type="none" level="false"/></center></laneSection></lanes>'
        f'<signals>{sigs}</signals></road>'
    )


def xodr(roads, controllers=(), date="2026-08-28T00:00:00", north=100, south=-100, east=100, west=-100):
    ctrl = "".join(
        f'<controller id="{cid}">' + "".join(f'<control signalId="{s}"/>' for s in members) + "</controller>"
        for cid, members in controllers
    )
    return (
        '<?xml version="1.0"?><OpenDRIVE>'
        f'<header revMajor="1" revMinor="4" date="{date}" north="{north}" south="{south}" east="{east}" west="{west}">'
        f"<geoReference><![CDATA[{GEO}]]></geoReference></header>"
        + "".join(roads) + ctrl + "</OpenDRIVE>"
    ).encode()


def base_roads(ids=("1", "2"), sig_ids=("100",), **kw):
    return [
        road(ids[0], 0, 0, 0, 50, succ=(ids[1], "start"), signals=[(sig_ids[0], 45, -2, "yes")]),
        road(ids[1], 50, 0, 0, 30, pred=(ids[0], "end"), **kw),
    ]


# -- xodr_identity -----------------------------------------------------------------

def test_byte_identical_worlds_are_exact():
    data = xodr(base_roads(), controllers=[("7", ["100"])])
    result = xodr_identity.compare(xodr_identity.parse(data), xodr_identity.parse(data))
    assert result.byte_exact and result.geometry_equivalent and not result.blocking


def test_renumbered_ids_pair_by_geometry_and_yield_a_signal_map():
    source = xodr(base_roads(), controllers=[("7", ["100"])], date="2026-08-28")
    world = xodr(base_roads(ids=("11", "12"), sig_ids=("900",)), controllers=[("70", ["900"])], date="2026-06-22")
    result = xodr_identity.compare(xodr_identity.parse(source), xodr_identity.parse(world))
    assert result.geometry_equivalent and not result.blocking and not result.decision_required
    assert result.roads["renumbered"] == 2 and result.roads["linkMismatches"] == 0
    assert result.signal_id_map == {"100": "900"}
    assert result.controllers == {"source": 1, "runtime": 1, "paired": 1, "onlySource": 0, "onlyRuntime": 0}
    assert any("road ids renumbered" in d for d in result.differences)


def test_a_road_exported_backwards_is_the_same_road():
    source = xodr([road("1", 0, 0, 0, 20, lanes="right")])
    world = xodr([road("5", 0, 0, 0, 20, lanes="right", reverse=True)])
    result = xodr_identity.compare(xodr_identity.parse(source), xodr_identity.parse(world))
    assert result.geometry_equivalent, result.blocking
    assert result.roads["reversed"] == ["1"]


def test_a_moved_road_is_a_different_network():
    source = xodr(base_roads())
    moved = xodr([road("1", 0, 0.05, 0, 50, succ=("2", "start"), signals=[("100", 45, -2, "yes")]),
                  road("2", 50, 0.05, 0, 30, pred=("1", "end"))])
    result = xodr_identity.compare(xodr_identity.parse(source), xodr_identity.parse(moved))
    assert not result.geometry_equivalent
    assert any("road network differs" in b for b in result.blocking)


def test_millimetre_reserialization_noise_is_tolerated():
    source = xodr(base_roads())
    noisy = xodr([road("1", 0.004, 0, 0, 50.003, succ=("2", "start"), signals=[("100", 45, -2, "yes")]),
                  road("2", 50.004, 0, 0, 30, pred=("1", "end"))])
    result = xodr_identity.compare(xodr_identity.parse(source), xodr_identity.parse(noisy))
    assert result.geometry_equivalent, result.blocking


def test_signals_the_source_dropped_need_a_decision():
    source = xodr([road("1", 0, 0, 0, 50)])
    world = xodr([road("1", 0, 0, 0, 50, signals=[("100", 45, -2, "yes")])], controllers=[("7", ["100"])])
    result = xodr_identity.compare(xodr_identity.parse(source), xodr_identity.parse(world))
    assert result.geometry_equivalent and not result.blocking
    assert len(result.decision_required) == 2


# -- generator ---------------------------------------------------------------------

def _inputs(tmp_path: Path) -> Path:
    inputs = tmp_path / "inputs"
    folders = {
        "Exact": xodr(base_roads(), north=10),
        "Renumbered": xodr(base_roads(), north=20),
        "Changed": xodr(base_roads(), north=30),
        "Dropped": xodr([road("1", 0, 0, 0, 50)], north=40),
        "Orphan": xodr(base_roads(), north=50, south=40, east=1000, west=900),
    }
    worlds = {
        "World_Exact": folders["Exact"],
        "World_Renumbered": xodr(base_roads(ids=("11", "12"), sig_ids=("900",)), north=20),
        "World_Changed": xodr([road("1", 0, 1, 0, 50), road("2", 50, 1, 0, 30)], north=30),
        "World_Dropped": xodr([road("1", 0, 0, 0, 50, signals=[("100", 45, -2, "yes")])], controllers=[("7", ["100"])], north=40),
    }
    files = []
    for folder, data in folders.items():
        (inputs / "nas" / folder).mkdir(parents=True)
        (inputs / "nas" / folder / f"{folder}.xodr").write_bytes(data)
        files.append({"path": f"{folder}/{folder}.xodr", "folder": folder, "name": f"{folder}.xodr", "bytes": len(data),
                      "mtime": "2026-08-31T00:00:00Z", "sha256": hashlib.sha256(data).hexdigest()})
        files.append({"path": f"{folder}/{folder}_GLB.glb", "folder": folder, "name": f"{folder}_GLB.glb", "bytes": 1,
                      "mtime": "2026-08-31T00:00:00Z", "sha256": "0" * 64})
    # A stray copy of another folder's XODR next to Exact's own pair.
    stray = folders["Dropped"]
    (inputs / "nas" / "Exact" / "Dropped.xodr").write_bytes(stray)
    files.append({"path": "Exact/Dropped.xodr", "folder": "Exact", "name": "Dropped.xodr", "bytes": len(stray),
                  "mtime": "2026-08-31T00:00:00Z", "sha256": hashlib.sha256(stray).hexdigest()})
    (inputs / "nas.json").write_text(json.dumps({"root": "/nas", "files": files}))
    (inputs / "cooked").mkdir()
    for world, data in worlds.items():
        (inputs / "cooked" / f"{world}.xodr").write_bytes(data)
    (inputs / "cooked.json").write_text(json.dumps({
        "image": "cook:1", "imageId": "sha256:" + "1" * 64, "repoDigests": [], "engineBinarySha256": "2" * 64,
        "version": {}, "worlds": {w: {"xodrSha256": hashlib.sha256(d).hexdigest()} for w, d in worlds.items()},
    }))
    (inputs / "simforge-dev.json").write_text(json.dumps({"mapAssets": [{
        "id": "renumbered-asset", "label": "Renumbered", "carlaMapName": None, "ue5CarlaMapName": None,
        "mapVersions": [{"id": "usmap_a", "xodrSha256": hashlib.sha256(folders["Renumbered"]).hexdigest(),
                         "createdAt": "2026-09-20", "retiredAt": None, "dependents": {"documents": 3}}],
    }]}))
    return inputs


def test_generator_derives_every_status(tmp_path):
    manifest = generate.generate(_inputs(tmp_path), {})
    world_manifest.validate(manifest)
    by = {e["sourceFolder"]: e for e in manifest["maps"]}
    assert by["Exact"]["status"] == "exact" and by["Exact"]["carlaWorld"] == "World_Exact"
    assert by["Exact"]["xodr"]["name"] == "Exact.xodr"  # the XODR that matches the GLB
    assert by["Exact"]["extraFiles"][0]["duplicateOf"] == "Dropped/Dropped.xodr"
    assert by["Renumbered"]["status"] == "approved-equivalent"
    assert by["Renumbered"]["signalIdMap"] == {"100": "900"}
    assert by["Renumbered"]["simforge"]["dev"]["mapAssetId"] == "renumbered-asset"
    assert by["Changed"]["status"] == "needs-recook" and by["Changed"]["signalIdMap"] == {}
    assert by["Dropped"]["status"] == "needs-decision"
    assert by["Orphan"]["status"] == "no-world" and by["Orphan"]["carlaWorld"] is None
    assert generate.dump(manifest) == generate.dump(generate.generate(_inputs(tmp_path / "again"), {}))


def test_decisions_accept_exact_items_and_holds_win(tmp_path):
    inputs = _inputs(tmp_path)
    first = {e["sourceFolder"]: e for e in generate.generate(inputs, {})["maps"]}
    items = first["Dropped"]["decisionRequired"]
    decided = {e["sourceFolder"]: e for e in generate.generate(inputs, {
        "Dropped": {"acceptDecisionItems": items, "decidedBy": "test", "date": "2026-09-22"},
        "Renumbered": {"hold": "waiting for QA", "decidedBy": "test", "date": "2026-09-22"},
    })["maps"]}
    assert decided["Dropped"]["status"] == "approved-equivalent"
    assert decided["Renumbered"]["status"] == "needs-decision" and decided["Renumbered"]["signalIdMap"] == {}
    partial = {e["sourceFolder"]: e for e in generate.generate(inputs, {
        "Dropped": {"acceptDecisionItems": items[:1]}})["maps"]}
    assert partial["Dropped"]["status"] == "needs-decision"


def test_generate_check_flags_a_stale_manifest(tmp_path):
    inputs = _inputs(tmp_path)
    out = tmp_path / "manifest.json"
    decisions = tmp_path / "decisions.json"
    decisions.write_text("{}")
    assert cli_main(["generate", "--inputs", str(inputs), "--out", str(out), "--decisions", str(decisions)]) == 0
    assert cli_main(["generate", "--inputs", str(inputs), "--out", str(out), "--decisions", str(decisions), "--check"]) == 0
    out.write_text(out.read_text().replace("World_Renumbered", "World_Renamed", 1))
    assert cli_main(["generate", "--inputs", str(inputs), "--out", str(out), "--decisions", str(decisions), "--check"]) == 1


def test_validate_rejects_a_world_bound_twice_and_unbound_signal_maps(tmp_path):
    manifest = generate.generate(_inputs(tmp_path), {})
    twice = json.loads(json.dumps(manifest))
    by = {e["sourceFolder"]: e for e in twice["maps"]}
    by["Renumbered"]["carlaWorld"] = "World_Exact"
    with pytest.raises(ValueError, match="is bound by"):
        world_manifest.validate(twice)
    stray = json.loads(json.dumps(manifest))
    {e["sourceFolder"]: e for e in stray["maps"]}["Changed"]["signalIdMap"] = {"1": "2"}
    with pytest.raises(ValueError, match="must not carry a signal id map"):
        world_manifest.validate(stray)


# -- the checked-in manifest and the runtime tables it drives --------------------------

SARATOGA = "ff368b92160bf1d8bc726a39039cb225be81a85518b0630ba8671e69f649c4f6"
SR_P1 = "eaeebc429898aca03dc8b399e23cef1d7e129784f607350ad974cf0f012ded55"
SR_P2 = "9098904a93bd40a930c4231442dc32b5b1e132d98c01b073da50e570c54e6bd9"
SR_PHASE2 = "c40e43731e4b4f5ab7c92e5ed9aec30452d58bfe2f17919fd1bd21fff67a6845"
BELMONT_CURRENT = "e4ec8cab3f9ce8c7faa4804348e1978e70d52acd5d0dcd0696b30e6d2d498e10"


def test_checked_in_manifest_binds_the_equivalent_worlds():
    manifest = world_manifest.load()
    bindings = world_manifest.bindings(manifest)
    assert bindings[SARATOGA].world == "Saratoga_School_Area"
    assert bindings[SR_P1].world == "San_Ramon_Phase_1_P1"
    assert bindings[SR_P2].world == "San_Ramon_Phase_1_P2"
    assert len(bindings[SR_P1].signal_id_map) == 148 and len(bindings[SR_P2].signal_id_map) == 106
    assert backend_module.cooked_map_name_for_xodr(SR_P2) == "San_Ramon_Phase_1_P2"
    assert backend_module.approved_cooked_xodr_digests(SR_P1) == {bindings[SR_P1].runtime_xodr_sha256}


def test_checked_in_manifest_keeps_the_rc73_bindings_verbatim():
    legacy = {b.source_xodr_sha256: b for b in world_manifest.bindings().values() if b.origin.startswith("legacy:")}
    expected = {
        "80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643": ("Richmond_Field_Station_Richmond_CA", "1576737df37adb4caad6bef62210e060fcbf5c9a082ddd269515417616a36111", 8),
        "00293fb5a40e6665257770f20eddbd0cbd711b301cce17496544c0e1fa15900a": ("El_Camino_Rd_Palo_Alto_CA", "97feee3176b26bfad8e96b58aa1682f54a89a0cd1651bc397b459b49b5db9665", 22),
        "fbebbdccd6a6b5dfa18a321d74009dede3851f18b673a9b807e6f1b5ea3b17d5": ("Yale_St_Palo_Alto_CA", "c7e95b5eeb8a58fadec6b26b9e73c41753cd21428039f0d44e541bbef1644f6f", 45),
        "35cf2b16a1d308c6436089a0edf66f20c87a79da12e79472a03a2f568ba28f63": ("Belmont_Office_Park_Belmont_CA", "a345d71de6cee091ee7d2ad4d0dfbf0a49db59ab9927cd22d4dd0dcd3e3eca4d", 0),
    }
    assert {k: (b.world, b.runtime_xodr_sha256, len(b.signal_id_map)) for k, b in legacy.items()} == expected
    assert legacy["80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643"].signal_id_map["374"] == "432"


def test_unbound_sources_are_refused_with_the_manifest_reason():
    assert SR_PHASE2 in backend_module.UNBINDABLE_COOKED_SOURCES
    assert "needs-decision" in backend_module.cooked_world_refusal(SR_PHASE2)
    assert "needs-recook" in backend_module.cooked_world_refusal(BELMONT_CURRENT)
    assert backend_module.cooked_world_refusal(SR_P1) is None


def test_env_cannot_bind_or_approve_a_refused_source(monkeypatch):
    monkeypatch.setenv("SIMFORGE_CARLA_COOKED_MAPS_JSON", json.dumps({"San_Ramon_Phase_2": SR_PHASE2}))
    with pytest.raises(RuntimeError, match="cannot bind"):
        backend_module.cooked_map_name_for_xodr(SR_PHASE2)
    monkeypatch.delenv("SIMFORGE_CARLA_COOKED_MAPS_JSON")
    monkeypatch.setenv("SIMFORGE_CARLA_APPROVED_COOKED_XODR_JSON", json.dumps({SR_PHASE2: ["a" * 64]}))
    with pytest.raises(RuntimeError, match="cannot approve"):
        backend_module.approved_cooked_xodr_digests(SR_PHASE2)


def test_load_opendrive_refuses_a_known_unbound_source_before_touching_carla(monkeypatch):
    body = b"<OpenDRIVE needs-recook/>"
    sha = hashlib.sha256(body).hexdigest()
    monkeypatch.setattr(backend_module, "UNBINDABLE_COOKED_SOURCES", {
        sha: world_manifest.Refusal(sha, "needs-recook", "Belmont_Office_Park_Belmont_CA", "road network differs", "Belmont"),
    })
    monkeypatch.delenv("SIMFORGE_CARLA_MAP_BINDING", raising=False)
    backend = object.__new__(CarlaBackend)
    backend.client = type("Client", (), {
        "get_available_maps": lambda _self: pytest.fail("a refused source must not reach the server"),
    })()
    with pytest.raises(RuntimeError, match=r"\[carla_map_world_unbound\] .*needs-recook: road network differs"):
        backend.load_opendrive("Belmont_Office_Park_Belmont_CA", body, 0.02)


def test_unversioned_local_catalog_is_content_addressed():
    from simforge_oss_carla_exec.runtime.backend import asset_catalog_version_id, runtime_asset_bindings
    body = {"contractVersion": "uniscenario.asset-catalog/v1", "entries": []}
    sha = "ab" * 32
    assert asset_catalog_version_id(body, sha) == f"catalog_local_{sha}"
    assert asset_catalog_version_id({**body, "catalogVersionId": "uscatalog-1"}, sha) == "uscatalog-1"
    assert asset_catalog_version_id({**body, "catalogVersionId": ""}, sha) is None
    assert asset_catalog_version_id({**body, "contractVersion": "other"}, sha) is None
    assert asset_catalog_version_id(body, None) is None
    assert runtime_asset_bindings(body, expected_catalog_version_id=f"catalog_local_{sha}", manifest_sha256=sha) == {}
    with pytest.raises(Exception, match="version does not match"):
        runtime_asset_bindings(body, expected_catalog_version_id=f"catalog_local_{'cd' * 32}", manifest_sha256=sha)


# -- CARLA actor binding table --------------------------------------------------------

def _object_catalog():
    return {
        "contractVersion": "simcloud.carla-object-catalog/v1", "carlaVersion": "0.10.0", "generatedFrom": {},
        "objects": [
            {"id": "carla.vehicle_gazelle_omafiets", "actorClass": "bicycle", "carla": {"blueprintId": "vehicle.gazelle.omafiets"}},
            {"id": "carla.walker_0016", "actorClass": "pedestrian", "carla": {"blueprintId": "walker.pedestrian.0016"}},
        ],
        "equivalents": [
            {"catalogId": "vehicle.bicycle", "blueprintId": "vehicle.gazelle.omafiets", "carlaObjectId": "carla.vehicle_gazelle_omafiets",
             "fidelity": "native-blueprint", "dimensionalAgreement": "close"},
            {"catalogId": "pedestrian.adult", "blueprintId": "walker.pedestrian.0016", "carlaObjectId": "carla.walker_0016",
             "fidelity": "native-blueprint", "dimensionalAgreement": "loose"},
        ],
        "unavailable": [{"catalogId": "animal.cat", "reason": "no CARLA animal blueprint matches this model"}],
    }


def _table(subs=None):
    from simforge_oss_carla_exec import actor_bindings
    body = json.dumps(actor_bindings.generate(_object_catalog(), "0" * 64, subs, "1" * 64 if subs else None)).encode()
    return actor_bindings.parse(body)


def test_actor_binding_table_binds_walkers_with_a_class_and_fails_unbound_by_name():
    from simforge_oss_carla_exec.runtime.backend import runtime_asset_bindings
    table = _table({"substitutions": {"vehicle.bus": {"carla": None, "reason": "no bus body"}}})
    assert table.bindings["pedestrian.adult"]["actorClass"] == "pedestrian"
    assert table.unavailable["vehicle.bus"].startswith("renderer parity")
    catalog = {"contractVersion": "uniscenario.asset-catalog/v1", "entries": [
        {"id": "pedestrian.adult", "class": "pedestrian", "dims": {"l": 0.3, "w": 0.5, "h": 1.75}},
        {"id": "vehicle.bicycle", "actorClass": "bicycle"},
        {"id": "animal.cat"}, {"id": "vehicle.unknown"},
    ]}
    sha = "ab" * 32
    index = runtime_asset_bindings(catalog, expected_catalog_version_id=f"catalog_local_{sha}", manifest_sha256=sha, actor_bindings=table)
    assert index["pedestrian.adult"]["blueprintId"] == "walker.pedestrian.0016"
    assert index["pedestrian.adult"]["actorClass"] == "pedestrian"
    assert index["pedestrian.adult"]["bindingSource"] == "carla-actor-bindings"
    assert index["vehicle.bicycle"]["blueprintId"] == "vehicle.gazelle.omafiets"
    assert "blueprintId" not in index["animal.cat"] and "animal" in index["animal.cat"]["unavailableReason"]
    assert "has no binding" in index["vehicle.unknown"]["unavailableReason"]


def test_a_catalog_binding_that_disagrees_with_the_table_is_refused():
    from simforge_oss_carla_exec.runtime.backend import runtime_asset_bindings
    catalog = {"contractVersion": "uniscenario.asset-catalog/v1", "catalogVersionId": "v", "entries": [
        {"id": "vehicle.bicycle", "runtimeBindings": {"carla": {"blueprintId": "vehicle.diamondback.century", "fidelity": "native-blueprint"}}},
    ]}
    with pytest.raises(RuntimeError, match="carla_actor_binding_conflict"):
        runtime_asset_bindings(catalog, expected_catalog_version_id="v", actor_bindings=_table())


def test_parity_substitutions_must_agree_with_the_object_catalog():
    from simforge_oss_carla_exec import actor_bindings
    with pytest.raises(ValueError, match="binds vehicle.bicycle"):
        actor_bindings.generate(_object_catalog(), "0" * 64,
                                {"substitutions": {"vehicle.bicycle": {"carla": "vehicle.diamondback.century"}}}, "1" * 64)


def test_checked_in_actor_binding_table_covers_the_dev_road_users():
    from simforge_oss_carla_exec import actor_bindings
    table = actor_bindings.load()
    for catalog_id, blueprint in {
        "pedestrian.adult": "walker.pedestrian.0016", "vehicle.bicycle": "vehicle.gazelle.omafiets",
        "vehicle.motorcycle": "vehicle.harley.lowrider", "vehicle.delivery_van": "vehicle.sprinter.mercedes",
        "vehicle.sedan": "vehicle.lincoln.mkz", "vehicle.hatchback": "vehicle.mini.cooper",
    }.items():
        assert table.bindings[catalog_id]["blueprintId"] == blueprint, catalog_id
    assert table.evidence()["sha256"] == table.sha256


def test_placement_probes_are_destroyed_server_side_in_synchronous_mode():
    """actor.destroy() on a probe spawned since the last synchronous tick returns
    False and leaves the actor in the world; the batch command removes it."""
    from types import SimpleNamespace
    calls = []
    backend = object.__new__(CarlaBackend)
    backend.carla = SimpleNamespace(command=SimpleNamespace(DestroyActor=lambda actor_id: ("destroy", actor_id)))
    backend.client = SimpleNamespace(apply_batch_sync=lambda commands, _tick: calls.extend(commands) or [SimpleNamespace(error="")])
    probe = SimpleNamespace(id=42, destroy=lambda: pytest.fail("actor.destroy() leaks pre-tick probes"))
    backend._destroy_probe("vehicle.gazelle.omafiets", probe)
    assert calls == [("destroy", 42)]
    backend.client = SimpleNamespace(apply_batch_sync=lambda commands, _tick: [SimpleNamespace(error="actor not found")])
    with pytest.raises(RuntimeError, match="failed to destroy the vehicle.gazelle.omafiets placement probe: actor not found"):
        backend._destroy_probe("vehicle.gazelle.omafiets", probe)


def test_a_walker_satisfies_all_off_lights_and_fails_a_lit_one():
    from types import SimpleNamespace
    backend = object.__new__(CarlaBackend)
    backend.carla = SimpleNamespace(VehicleLightState=None)
    walker = SimpleNamespace(type_id="walker.pedestrian.0016")
    backend._apply_appearance("ped", walker, {"light.brakeLights": "off", "light.lowBeam": "off"}, 0.0)
    assert backend.appearance_verification["ped"]["light.brakeLights"] == "body-has-no-lights"
    with pytest.raises(RuntimeError, match="carla_actor_lights_unsupported"):
        backend._apply_appearance("ped", walker, {"light.brakeLights": "on"}, 0.0)


def test_carla_010_bone_readback_names_bones_name():
    from types import SimpleNamespace
    from simforge_oss_carla_exec.runtime.policy import bone_pose_signature
    rot = lambda p: SimpleNamespace(rotation=SimpleNamespace(pitch=p, yaw=0.0, roll=0.0))
    bones = SimpleNamespace(bone_transforms=[
        SimpleNamespace(name="crl_root", relative=rot(0.0)), SimpleNamespace(name="crl_thigh__R", relative=rot(12.0)),
        SimpleNamespace(bone_name="thigh_l", relative=rot(3.0)),
    ])
    assert bone_pose_signature(bones) == {"crl_thigh__R": (12.0, 0.0, 0.0), "thigh_l": (3.0, 0.0, 0.0)}
