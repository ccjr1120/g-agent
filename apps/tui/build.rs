use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"),
    );
    let repo_root = manifest.join("../..");
    let server_entry = repo_root.join("apps/server/src/index.ts");

    if server_entry.is_file() {
        let canonical = repo_root
            .canonicalize()
            .unwrap_or_else(|_| repo_root.clone());
        println!("cargo:rustc-env=G_AGENT_BUILD_ROOT={}", canonical.display());
        println!("cargo:rerun-if-changed=../../apps/server/src/index.ts");
    }
}
