# Converts the mascot PNGs into the raw RGBA files the app embeds (crates/app/images/*.rgba).
# The app has no PNG decoder (no image crate: fewer dependencies for the licence check), so the
# pixels are decoded here once and checked in. Re-run after changing a source picture:
#   powershell -File scripts/make-images.ps1 -Source <folder with the PNGs>
# Laptop states: the near-white background reachable from the edges becomes transparent, the
# picture is cropped to the character, padded to a square and scaled to 192 px. The About picture
# keeps its background and is scaled to 720 px wide. The exe icon is the Working laptop as
# icon-<size>.png (16 to 256 px).
# File format: width (u32 LE), height (u32 LE), then width*height RGBA bytes (not premultiplied).
param([Parameter(Mandatory = $true)][string]$Source)

$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot '..\crates\app\images'
New-Item -ItemType Directory -Force $out | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class Mascot {
  static byte[] Read(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[b.Width * b.Height * 4];
    System.Runtime.InteropServices.Marshal.Copy(d.Scan0, px, 0, px.Length);
    b.UnlockBits(d);
    return px; // BGRA
  }
  static Bitmap FromBgra(byte[] px, int w, int h) {
    var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    System.Runtime.InteropServices.Marshal.Copy(px, 0, d.Scan0, px.Length);
    b.UnlockBits(d);
    return b;
  }
  static bool Background(byte[] px, int i) {
    int bl = px[i], g = px[i + 1], r = px[i + 2];
    int max = Math.Max(r, Math.Max(g, bl)), min = Math.Min(r, Math.Min(g, bl));
    // The generated background is a neutral off-white (~252); screens are warmer or bluer whites,
    // so only near-grey light pixels count, or the fill leaks into a screen through a gap.
    return min >= 236 && max - min <= 7;
  }
  // Flood-fills the near-white background from the edges to transparent, with a soft 1 px edge.
  static void KnockOut(byte[] px, int w, int h) {
    var seen = new bool[w * h];
    var q = new Queue<int>();
    for (int x = 0; x < w; x++) { q.Enqueue(x); q.Enqueue((h - 1) * w + x); }
    for (int y = 0; y < h; y++) { q.Enqueue(y * w); q.Enqueue(y * w + w - 1); }
    while (q.Count > 0) {
      int p = q.Dequeue();
      if (seen[p] || !Background(px, p * 4)) continue;
      seen[p] = true;
      px[p * 4 + 3] = 0;
      int x = p % w, y = p / w;
      if (x > 0) q.Enqueue(p - 1);
      if (x < w - 1) q.Enqueue(p + 1);
      if (y > 0) q.Enqueue(p - w);
      if (y < h - 1) q.Enqueue(p + w);
    }
    // Pixels next to the cleared area fade by how light they are, so the outline has no white fringe.
    for (int y = 1; y < h - 1; y++) for (int x = 1; x < w - 1; x++) {
      int p = y * w + x;
      if (seen[p]) continue;
      if (!(seen[p - 1] || seen[p + 1] || seen[p - w] || seen[p + w])) continue;
      int lum = (px[p * 4] + px[p * 4 + 1] + px[p * 4 + 2]) / 3;
      if (lum > 200) px[p * 4 + 3] = (byte)Math.Max(0, Math.Min(255, (255 - lum) * 255 / 55));
    }
  }
  static void Write(Bitmap b, string path) {
    var px = Read(b);
    using (var f = new BinaryWriter(File.Create(path))) {
      f.Write((uint)b.Width); f.Write((uint)b.Height);
      for (int i = 0; i < px.Length; i += 4) { f.Write(px[i + 2]); f.Write(px[i + 1]); f.Write(px[i]); f.Write(px[i + 3]); }
    }
  }
  static Bitmap Scale(Bitmap src, Rectangle from, int w, int h) {
    var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(dst)) {
      g.CompositingMode = CompositingMode.SourceCopy;
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      using (var a = new ImageAttributes()) {
        a.SetWrapMode(WrapMode.TileFlipXY);
        g.DrawImage(src, new Rectangle(0, 0, w, h), from.X, from.Y, from.Width, from.Height, GraphicsUnit.Pixel, a);
      }
    }
    return dst;
  }
  // The exe icon: the same cropped square saved as PNGs (Windows icons may hold PNG images).
  public static void Icon(string png, string outDir, int[] sizes) {
    foreach (var size in sizes) {
      var tmp = Path.Combine(outDir, "icon-tmp.rgba");
      Laptop(png, tmp, size);
      var raw = File.ReadAllBytes(tmp);
      File.Delete(tmp);
      var px = new byte[size * size * 4];
      for (int i = 0; i < px.Length; i += 4) { px[i] = raw[8 + i + 2]; px[i + 1] = raw[8 + i + 1]; px[i + 2] = raw[8 + i]; px[i + 3] = raw[8 + i + 3]; }
      using (var b = FromBgra(px, size, size)) b.Save(Path.Combine(outDir, "icon-" + size + ".png"), ImageFormat.Png);
    }
  }
  public static void Laptop(string png, string outPath, int size) {
    using (var src = new Bitmap(png)) {
      int w = src.Width, h = src.Height;
      var px = Read(src);
      KnockOut(px, w, h);
      int x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 24) {
        x0 = Math.Min(x0, x); y0 = Math.Min(y0, y); x1 = Math.Max(x1, x); y1 = Math.Max(y1, y);
      }
      int side = Math.Max(x1 - x0, y1 - y0) + 8;
      int cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      // Pad to a square on a transparent canvas, then scale.
      var sq = new byte[side * side * 4];
      for (int y = 0; y < side; y++) for (int x = 0; x < side; x++) {
        int sx = cx - side / 2 + x, sy = cy - side / 2 + y;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        Array.Copy(px, (sy * w + sx) * 4, sq, (y * side + x) * 4, 4);
      }
      using (var square = FromBgra(sq, side, side))
      using (var small = Scale(square, new Rectangle(0, 0, side, side), size, size)) Write(small, outPath);
    }
  }
  public static void Scene(string png, string outPath, int width) {
    using (var src = new Bitmap(png)) {
      int height = src.Height * width / src.Width;
      using (var small = Scale(src, new Rectangle(0, 0, src.Width, src.Height), width, height)) Write(small, outPath);
    }
  }
}
"@

foreach ($name in 'laptop-working', 'laptop-sleeping', 'laptop-equipment', 'laptop-not-started', 'laptop-wake-up') {
  [Mascot]::Laptop((Join-Path $Source "$name.png"), (Join-Path $out "$name.rgba"), 192)
  Write-Output "images: $name.rgba"
}
[Mascot]::Scene((Join-Path $Source 'about-desk.png'), (Join-Path $out 'about.rgba'), 720)
Write-Output 'images: about.rgba'
# The exe icon (crates/app/icon.rs packs these into a Windows resource at build time).
[Mascot]::Icon((Join-Path $Source 'laptop-working.png'), $out, [int[]](16, 24, 32, 48, 64, 256))
Write-Output 'images: icon-*.png'
