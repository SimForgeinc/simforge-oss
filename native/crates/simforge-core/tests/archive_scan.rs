//! Developer scan (ignored): read every trace under `SIMFORGE_TRACE_SCAN_DIR`
//! through the upgrader chain and group the failures.
//! `SIMFORGE_TRACE_SCAN_DIR=/path cargo test -p simforge-core --test archive_scan -- --ignored --nocapture`

use std::collections::BTreeMap;

use simforge_core::trace::timeline::{build_render_timeline, maybe_gunzip, HeightField};
use simforge_core::trace::SimTrace;

#[test]
#[ignore]
fn scan_directory() {
    let dir = std::env::var("SIMFORGE_TRACE_SCAN_DIR").expect("SIMFORGE_TRACE_SCAN_DIR");
    let mut ok = 0;
    let mut shapes: BTreeMap<String, usize> = BTreeMap::new();
    let mut fails: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "txt") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        let plain = maybe_gunzip(&bytes).unwrap();
        match SimTrace::from_json_slice(&plain) {
            Ok(t) => {
                ok += 1;
                if t.upgrade.is_none() {
                    let value: serde_json::Value = serde_json::from_slice(&plain).unwrap();
                    let stored = simforge_core::hash::content_hash(&value).unwrap();
                    if stored != t.digest().unwrap() {
                        if let Ok(dump) = std::env::var("SIMFORGE_TRACE_SCAN_DUMP") {
                            let mut q = t.clone();
                            q.quantize();
                            let name = path.file_name().unwrap().to_string_lossy().to_string();
                            std::fs::write(
                                format!("{dump}/{name}.struct.json"),
                                serde_json::to_string(&q).unwrap(),
                            )
                            .unwrap();
                        }
                        fails
                            .entry("current digest != stored-document digest".into())
                            .or_default()
                            .push(path.file_name().unwrap().to_string_lossy().into());
                    }
                }
                if let Err(e) = build_render_timeline(&t, &HeightField::flat(0.0), None) {
                    fails
                        .entry(format!("timeline: {e}").chars().take(160).collect())
                        .or_default()
                        .push(path.file_name().unwrap().to_string_lossy().into());
                }
                let key = t
                    .upgrade
                    .as_ref()
                    .map(|u| format!("{} {:?}", u.source_shape, u.unrecorded))
                    .unwrap_or_else(|| "current".into());
                *shapes.entry(key).or_default() += 1;
            }
            Err(e) => {
                let msg = e.to_string();
                let key: String = msg.chars().take(160).collect();
                fails
                    .entry(key)
                    .or_default()
                    .push(path.file_name().unwrap().to_string_lossy().into());
            }
        }
    }
    println!("ok {ok}");
    for (k, v) in &shapes {
        println!("  {v} × {k}");
    }
    for (k, v) in &fails {
        println!("FAIL {} × {k}\n    e.g. {}", v.len(), v[0]);
    }
}
