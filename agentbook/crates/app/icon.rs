// The exe's own icon (what Explorer, the Start menu and the taskbar pin show), shared by the build
// scripts of the app and of the installer (`include!`d there). It writes a compiled Windows
// resource file (.res) by hand, with no resource compiler or extra crate: one RT_ICON per
// `images/icon-<size>.png` (Windows icons may hold PNG images) and one RT_GROUP_ICON (id 1, the
// one Explorer shows) listing them. MSVC's link.exe takes the .res file as an input. Other
// targets get no exe icon; the window icon is set at run time either way.

/// Writes `<OUT_DIR>/agentbook-icon.res` and links it into the binary `bin`.
pub fn link_exe_icon(images: &std::path::Path, bin: &str) {
    const SIZES: [u32; 6] = [16, 24, 32, 48, 64, 256];
    for size in SIZES {
        println!(
            "cargo:rerun-if-changed={}",
            images.join(format!("icon-{size}.png")).display()
        );
    }
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }
    let pngs: Vec<(u32, Vec<u8>)> = SIZES
        .iter()
        .map(|&size| {
            let path = images.join(format!("icon-{size}.png"));
            let bytes = std::fs::read(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            (size, bytes)
        })
        .collect();

    let mut res = Vec::new();
    // A .res file starts with an empty entry.
    entry(&mut res, 0, 0, 0, 0, &[]);
    const RT_ICON: u16 = 3;
    const RT_GROUP_ICON: u16 = 14;
    const LANG_EN_US: u16 = 0x0409;
    for (i, (_, png)) in pngs.iter().enumerate() {
        entry(&mut res, RT_ICON, i as u16 + 1, 0x1010, LANG_EN_US, png);
    }
    // GRPICONDIR + one 14-byte GRPICONDIRENTRY per image.
    let mut group = Vec::new();
    group.extend_from_slice(&0u16.to_le_bytes());
    group.extend_from_slice(&1u16.to_le_bytes());
    group.extend_from_slice(&(pngs.len() as u16).to_le_bytes());
    for (i, (size, png)) in pngs.iter().enumerate() {
        let side = if *size >= 256 { 0 } else { *size as u8 };
        group.extend_from_slice(&[side, side, 0, 0]);
        group.extend_from_slice(&1u16.to_le_bytes()); // planes
        group.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        group.extend_from_slice(&(png.len() as u32).to_le_bytes());
        group.extend_from_slice(&(i as u16 + 1).to_le_bytes());
    }
    entry(&mut res, RT_GROUP_ICON, 1, 0x1030, LANG_EN_US, &group);

    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let path = out.join("agentbook-icon.res");
    std::fs::write(&path, &res).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
    println!("cargo:rustc-link-arg-bin={bin}={}", path.display());
}

/// One resource: a 32-byte header with numeric type and name, the data, padding to 4 bytes.
fn entry(res: &mut Vec<u8>, kind: u16, name: u16, flags: u16, lang: u16, data: &[u8]) {
    res.extend_from_slice(&(data.len() as u32).to_le_bytes()); // DataSize
    res.extend_from_slice(&32u32.to_le_bytes()); // HeaderSize
    res.extend_from_slice(&[0xff, 0xff]);
    res.extend_from_slice(&kind.to_le_bytes());
    res.extend_from_slice(&[0xff, 0xff]);
    res.extend_from_slice(&name.to_le_bytes());
    res.extend_from_slice(&0u32.to_le_bytes()); // DataVersion
    res.extend_from_slice(&flags.to_le_bytes()); // MemoryFlags
    res.extend_from_slice(&lang.to_le_bytes()); // LanguageId
    res.extend_from_slice(&0u32.to_le_bytes()); // Version
    res.extend_from_slice(&0u32.to_le_bytes()); // Characteristics
    res.extend_from_slice(data);
    while !res.len().is_multiple_of(4) {
        res.push(0);
    }
}
