//! `ktx2-gpu-variant`: the ingest generator of the `textures-full-bc7` map
//! texture variant (see `render_core::ktx2_variant`).
//!
//!   ktx2-gpu-variant --out-dir DIR [--supercompression zstd|none] FILE.ktx2...
//!   ktx2-gpu-variant --fingerprint
//!
//! For every input it prints one JSON line:
//!   {"input", "inputSha256", "codec": "bc7"|"bc5"|"bc4"|"passthrough",
//!    "file": "<outputSha256>.ktx2" (absent for passthrough), "outputSha256",
//!    "vkFormat", "width", "height", "levels"}
//! and writes the variant to DIR/<outputSha256>.ktx2. Each variant is
//! verified to load to the source's exact blocks before it is written; any
//! failure exits non-zero. Output is deterministic (same input, same bytes).
use anyhow::{bail, Context, Result};
use render_core::ktx2_variant::{gpu_variant, Supercompression, VariantCodec, KTX2_GPU_VARIANT_TOOL};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fingerprint() -> Result<serde_json::Value> {
    let exe = std::env::current_exe().context("locate own binary")?;
    let binary = std::fs::read(&exe).with_context(|| format!("read {}", exe.display()))?;
    Ok(serde_json::json!({
        "tool": KTX2_GPU_VARIANT_TOOL,
        "binarySha256": sha256_hex(&binary),
        "transcoder": "bevy_image 0.19.1 ktx2_buffer_to_image (CompressedImageFormats::BC) / basis-universal 0.3.1",
        "supercompression": "ruzstd 0.8.3 Fastest",
    }))
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut out_dir: Option<PathBuf> = None;
    let mut supercompression = Supercompression::ZstdFastest;
    let mut inputs = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--fingerprint" => {
                println!("{}", fingerprint()?);
                return Ok(());
            }
            "--out-dir" => out_dir = Some(args.next().context("--out-dir requires a directory")?.into()),
            "--supercompression" => {
                supercompression = match args.next().as_deref() {
                    Some("zstd") => Supercompression::ZstdFastest,
                    Some("none") => Supercompression::None,
                    other => bail!("--supercompression zstd|none, got {other:?}"),
                }
            }
            "--help" | "-h" => {
                println!("ktx2-gpu-variant --out-dir DIR [--supercompression zstd|none] FILE.ktx2... | --fingerprint");
                return Ok(());
            }
            other if other.starts_with("--") => bail!("unknown argument {other}"),
            file => inputs.push(PathBuf::from(file)),
        }
    }
    let out_dir = out_dir.context("missing --out-dir")?;
    std::fs::create_dir_all(&out_dir).with_context(|| format!("create {}", out_dir.display()))?;
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<std::sync::Mutex<Option<Result<serde_json::Value>>>> = inputs.iter().map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..std::thread::available_parallelism().map_or(1, |n| n.get()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(input) = inputs.get(index) else { break };
                let result = (|| -> Result<serde_json::Value> {
                    let source = std::fs::read(input).with_context(|| format!("read {}", input.display()))?;
                    let variant = gpu_variant(&source, supercompression).with_context(|| input.display().to_string())?;
                    let mut record = serde_json::json!({
                        "input": input, "inputSha256": sha256_hex(&source), "codec": variant.codec.as_str(),
                        "width": variant.width, "height": variant.height, "levels": variant.levels,
                    });
                    if variant.codec != VariantCodec::Passthrough {
                        let bytes = variant.ktx2.expect("transcoded variant has bytes");
                        let digest = sha256_hex(&bytes);
                        let file = format!("{digest}.ktx2");
                        let target = out_dir.join(&file);
                        let temporary = out_dir.join(format!(".{file}.{}.tmp", std::process::id()));
                        std::fs::write(&temporary, &bytes).with_context(|| format!("write {}", temporary.display()))?;
                        std::fs::rename(&temporary, &target)?;
                        record["file"] = serde_json::json!(file);
                        record["outputSha256"] = serde_json::json!(digest);
                        record["vkFormat"] = serde_json::json!(variant.vk_format);
                    }
                    Ok(record)
                })();
                *results[index].lock().expect("result slot") = Some(result);
            });
        }
    });
    let mut failed = 0;
    for slot in results {
        match slot.into_inner().expect("result slot").expect("every input processed") {
            Ok(record) => println!("{record}"),
            Err(error) => {
                failed += 1;
                eprintln!("ktx2-gpu-variant: {error:#}");
            }
        }
    }
    if failed > 0 {
        bail!("{failed} of {} inputs failed", inputs.len());
    }
    Ok(())
}
