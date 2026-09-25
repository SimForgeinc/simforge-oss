use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use simforge_assets::{
    Closure, Error, Identity, Lock, Store, PINNED_ACTOR_CLOSURE, PINNED_SKY_CLOSURE,
    TREE_COMPLETE_MARKER,
};

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A local closure root (`closures/` + `blobs/`) holding `files`; returns its pin.
fn publish(root: &Path, files: &[(&str, &[u8])]) -> Identity {
    let mut members = BTreeMap::new();
    for (path, bytes) in files {
        let digest = sha(bytes);
        let blob = root.join("blobs/sha256").join(&digest[..2]).join(&digest);
        fs::create_dir_all(blob.parent().unwrap()).unwrap();
        fs::write(&blob, bytes).unwrap();
        members.insert(
            (*path).to_owned(),
            Identity::new(digest, bytes.len() as u64).unwrap(),
        );
    }
    let document = Closure::canonical_document(&members).unwrap();
    let id = Identity::new(sha(&document), document.len() as u64).unwrap();
    fs::create_dir_all(root.join("closures")).unwrap();
    fs::write(
        root.join("closures").join(format!("{}.json", id.sha256)),
        &document,
    )
    .unwrap();
    id
}

fn file_origin(root: &Path) -> String {
    format!("file://{}", root.display())
}

#[test]
fn materializes_a_closure_by_digest_and_reuses_the_tree() {
    let origin = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let id = publish(
        origin.path(),
        &[
            ("ATTRIBUTION.json", b"{\"license\":\"CC-BY-4.0\"}"),
            ("models/car.glb", b"glTF-car"),
            ("models/walker.glb", b"glTF-walker"),
        ],
    );
    let store = Store::new(&file_origin(origin.path()), cache.path());
    let mut fetched = 0;
    let first = store
        .materialize(&id, &mut |event| {
            let simforge_assets::Progress::Member { fetched: now, .. } = event;
            fetched += usize::from(now);
        })
        .unwrap();
    assert_eq!(fetched, 3);
    assert_eq!(
        fs::read(first.directory.join("models/car.glb")).unwrap(),
        b"glTF-car"
    );
    assert!(first.directory.join(TREE_COMPLETE_MARKER).is_file());
    assert!(
        first.directory.join("ATTRIBUTION.json").is_file(),
        "attribution travels with the models"
    );

    // A second materialize is offline: the origin can disappear.
    drop(origin);
    let again = store.materialize(&id, &mut |_| {}).unwrap();
    assert_eq!(again.directory, first.directory);
    assert!(store.materialized(&id).unwrap().is_some());
}

#[test]
fn a_missing_blob_is_a_loud_error_naming_the_digest() {
    let origin = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let id = publish(
        origin.path(),
        &[("catalog-models.json", b"{}"), ("models/x.glb", b"x")],
    );
    let digest = sha(b"x");
    fs::remove_file(
        origin
            .path()
            .join("blobs/sha256")
            .join(&digest[..2])
            .join(&digest),
    )
    .unwrap();
    let store = Store::new(&file_origin(origin.path()), cache.path());
    let error = store.materialize(&id, &mut |_| {}).unwrap_err();
    assert!(
        matches!(&error, Error::Unavailable { sha256, .. } if *sha256 == digest),
        "{error}"
    );
    assert!(
        !store.tree_path(&id.sha256).exists(),
        "no partial tree is published"
    );
}

#[test]
fn bytes_that_are_not_the_pinned_asset_are_refused() {
    let origin = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let id = publish(origin.path(), &[("models/x.glb", b"right")]);
    let digest = sha(b"right");
    let blob = origin
        .path()
        .join("blobs/sha256")
        .join(&digest[..2])
        .join(&digest);
    fs::write(&blob, b"wrong").unwrap();
    let store = Store::new(&file_origin(origin.path()), cache.path());
    let error = store.materialize(&id, &mut |_| {}).unwrap_err();
    assert!(matches!(error, Error::Mismatch { .. }), "{error}");
    assert!(
        !store.blob_path(&digest).exists(),
        "an unverified blob never enters the cache"
    );

    // A closure document that is not the pin is refused the same way.
    let wrong = Identity::new("0".repeat(64), id.bytes).unwrap();
    fs::copy(
        origin
            .path()
            .join("closures")
            .join(format!("{}.json", id.sha256)),
        origin
            .path()
            .join("closures")
            .join(format!("{}.json", wrong.sha256)),
    )
    .unwrap();
    assert!(matches!(
        store.pull_closure(&wrong).unwrap_err(),
        Error::Mismatch { .. }
    ));
}

fn repo_catalog() -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../catalog");
    dir.join("closures.lock.json").is_file().then_some(dir)
}

#[test]
fn the_repository_lock_parses_and_agrees_with_the_compiled_pin() {
    let Some(catalog) = repo_catalog() else {
        // Built outside the repository (a published crate): nothing to cross-check.
        return;
    };
    let lock = Lock::load(&catalog.join("closures.lock.json")).unwrap();
    assert_eq!(
        lock.get("actors").unwrap(),
        Identity::from(PINNED_ACTOR_CLOSURE)
    );
    assert_eq!(lock.get("sky").unwrap(), Identity::from(PINNED_SKY_CLOSURE));
    for (name, pinned) in &lock.closures {
        let Some(document) = &pinned.document else {
            continue;
        };
        let bytes = fs::read(catalog.join(document)).unwrap();
        let closure = Closure::parse(&bytes, &lock.get(name).unwrap()).unwrap();
        assert!(
            closure.members.contains_key("ATTRIBUTION.json"),
            "{name} carries its attribution"
        );
        assert!(
            closure.unlicensed().is_empty(),
            "{name}: every member of a public pack has a confirmed licence"
        );
        // The Rust and Node sealers write the same canonical bytes.
        assert_eq!(
            Closure::canonical_document_with_licenses(&closure.members, &closure.licenses).unwrap(),
            bytes,
            "{name}: canonical form"
        );
    }
}

#[test]
#[ignore = "network: fetches the pinned actor closure document from the public origin"]
fn the_public_origin_serves_the_pinned_actor_closure() {
    let cache = tempfile::tempdir().unwrap();
    let store = Store::new(simforge_assets::DEFAULT_ORIGIN, cache.path());
    let closure = store
        .pull_closure(&Identity::from(PINNED_ACTOR_CLOSURE))
        .unwrap();
    assert!(closure.members.contains_key("catalog-models.json"));
    let catalog = &closure.members["catalog-models.json"];
    let (path, fetched) = store.pull_blob(catalog).unwrap();
    assert!(fetched && path.is_file());
}

#[test]
#[ignore = "network: fetches the pinned actor closure document from the public origin"]
fn the_pinned_actor_closure_licenses_every_member_and_ships_its_attribution() {
    let cache = tempfile::tempdir().unwrap();
    let store = Store::new(simforge_assets::DEFAULT_ORIGIN, cache.path());
    let closure = store
        .pull_closure(&Identity::from(PINNED_ACTOR_CLOSURE))
        .unwrap();
    assert!(
        closure.unlicensed().is_empty(),
        "{:?}",
        closure.unlicensed()
    );
    assert!(closure.members.contains_key("ATTRIBUTION.json"));
}
