use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=src/nvcodec/encode.c");
    println!("cargo:rerun-if-changed=src/nvcodec/nvEncodeAPI.h");
    println!("cargo:rerun-if-changed=src/nvcodec/dynlink_cuda.h");
    if env::var_os("CARGO_FEATURE_GPU_VIDEO").is_none() { return; }
    assert_eq!(env::var("CARGO_CFG_TARGET_OS").unwrap(), "linux", "gpu-video requires Linux NVIDIA drivers");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let object = out.join("sensor_nvenc.o");
    assert!(Command::new(env::var_os("CC").unwrap_or_else(|| "cc".into()))
        .args(["-std=c11", "-O2", "-fPIC", "-c", "src/nvcodec/encode.c", "-o"])
        .arg(&object).status().expect("compile NVENC bridge").success());
    assert!(Command::new(env::var_os("AR").unwrap_or_else(|| "ar".into()))
        .arg("crs").arg(out.join("libsensor_nvenc.a")).arg(object)
        .status().expect("archive NVENC bridge").success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=sensor_nvenc");
    println!("cargo:rustc-link-lib=dl");
}
