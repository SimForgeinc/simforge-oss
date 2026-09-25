//! The catalog digests of the public Richmond fixture, as the TypeScript
//! reference computed them (`packages/cli/parity/catalog-digest-parity.mjs
//! --ts-only --maps richmond-field-station`). Every one is sha256 over
//! `JSON.stringify` output, so this pins key order and number printing.

use simforge_authoring::catalog::{create_catalog, CreateOptions};
use simforge_authoring::maps::MapRoot;

/// The public Richmond fixture as an installed-maps root (`map.xodr.gz` inflated).
fn fixture_maps(dst: &std::path::Path) {
    use std::io::Read;
    fn copy(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            let src = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if src.is_dir() {
                copy(&src, &to.join(&name));
            } else if name == "map.xodr.gz" {
                let mut text = Vec::new();
                flate2::read::GzDecoder::new(std::fs::File::open(&src).unwrap())
                    .read_to_end(&mut text)
                    .unwrap();
                std::fs::write(to.join("map.xodr"), text).unwrap();
            } else {
                std::fs::copy(&src, to.join(&name)).unwrap();
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .find(|p| p.join("fixtures").join("golden-traces").is_dir())
        .expect("SDK root with fixtures/golden-traces")
        .to_path_buf();
    copy(&root.join("fixtures/golden-traces/maps"), dst);
}

#[test]
fn richmond_fixture_catalog_digests_match_typescript() {
    let tmp = tempfile::tempdir().unwrap();
    fixture_maps(tmp.path());
    let root = MapRoot::at(tmp.path());
    let created = create_catalog(
        &root,
        &tmp.path().display().to_string(),
        &CreateOptions { map_ids: Some(vec!["richmond-field-station".into()]), ..CreateOptions::default() },
    )
    .expect("catalog");
    // One map cannot cover the taxonomy: the gap is a warning, not an error.
    let missing = created.coverage.as_ref().and_then(|c| c["missing"].as_array()).map_or(0, Vec::len);
    assert_eq!(missing, 27);
    let catalog = created.catalog;
    let slot = |i: usize, key: &str| {
        catalog.get("slots").and_then(|s| s.as_array()).unwrap()[i]
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap()
            .to_owned()
    };
    assert_eq!(
        catalog.get("catalogDigest").and_then(|v| v.as_str()),
        Some("c7e28b72ef2894eec3822155ec5a4f3bf79922e750aeb738ffd6f75aa754b7cb")
    );
    assert_eq!(slot(0, "designDigest"), "73ee282c02f86556e9c6356f7dbcb3ed09967aecedd68f11707071bdfa96e55f");
    assert_eq!(slot(99, "designDigest"), "77400549c23256bd7f089bcbf9094f5548e463b8fa5042fd2ddbc641890df738");
    assert_eq!(slot(0, "seed"), "e1bbe8723c5d5d741bb867ea695e53095b7206c9a77454393c75c7d67663003e");
    let maps = catalog.get("maps").and_then(|m| m.as_array()).unwrap();
    assert_eq!(
        maps[0].get("locationCatalogDigest").and_then(|v| v.as_str()),
        Some("de617e016028c045e6ccffca910da2ee845db2e7155bd36d18173533c12e36c5")
    );

    // The static verifier accepts it; the taxonomy the one-map fixture cannot
    // reach is a coverage warning, and a hard issue only on request.
    use simforge_authoring::catalog::verify::{validate_catalog, VerifyOptions};
    let report = validate_catalog(&catalog, &VerifyOptions::default()).unwrap();
    assert!(report.ok, "{:?}", report.issues.iter().map(|i| (i.code, &i.path)).collect::<Vec<_>>());
    assert_eq!(report.coverage.as_ref().and_then(|c| c["missing"].as_array()).map_or(0, Vec::len), 27);
    let strict = validate_catalog(&catalog, &VerifyOptions { require_full_coverage: true, ..VerifyOptions::default() }).unwrap();
    let codes: Vec<(&str, &str)> = strict.issues.iter().map(|i| (i.code, i.path.as_str())).collect();
    assert_eq!(codes, vec![("insufficient_taxonomy_breadth", "slots")]);
}
