---
type: "How-to"
title: "Local image generation (scripts/imagegen.js)"
description: "How to generate illustrations and icons from a text prompt on a local NVIDIA GPU with no Python and no cloud: stable-diffusion.cpp (Docker or native Windows CUDA build) plus FLUX.1-schnell, driven by scripts/imagegen.js; setup, presets and styles, prompt tips, what never goes into git."
tags:
  - tooling
  - images
  - docker
  - gpu
generated: { by: "claude-code", at: "2026-11-26T02:00:00+04:00" }
---

# Local image generation

`scripts/imagegen.js` turns a prompt into a PNG on the developer's own GPU. It was made for the
AgentBook kawaii laptop icons (task `2026-11-25-local-sandbox-tool`) and is reusable for any
illustration: mascots, empty-state pictures, About dialogs, site art.

## Stack and why

- **Engine: [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)** (C++, MIT). No
  Python anywhere (repo rule), one binary, CUDA / Vulkan / CPU builds.
  - **Docker (default once the image is pulled):** image `ghcr.io/leejet/stable-diffusion.cpp:master-cuda`, run with
    `--gpus all`. Needs Docker Desktop with the NVIDIA runtime (WSL2 backend on Windows); the script
    picks Docker when `docker info` lists an `nvidia` runtime and the image is already local, else native (a `docker run` of a missing image would start a pull and sit in it).
  - **Native:** `setup --native` unpacks the latest Windows CUDA 12 release (`sd-cli.exe` plus the
    `cudart` zip) into `$IMAGEGEN_HOME/bin`. Use `--native` on `gen` to force it.
- **Model: FLUX.1-schnell** (Apache 2.0 — images are free to ship in the product), GGUF `Q5_K_S`
  (8.3 GB) so it fits a 12 GB card; T5-XXL encoder `Q8_0` GGUF and CLIP-L run on the CPU
  (`--backend te=cpu`), VAE with tiling. 4 steps, `cfg-scale 1`, `euler`. Total download ≈ 14 GB.
  - The FLUX VAE (`ae.safetensors`) is taken from the ungated Apache-2.0 repack
    `Comfy-Org/Lumina_Image_2.0_Repackaged`, because the `black-forest-labs` repo needs a Hugging
    Face login.
  - A smaller GPU (8 GB): swap `MODEL_FILES.diffusion` to `flux1-schnell-Q4_K_S.gguf`.

## Use

```sh
node scripts/imagegen.js setup            # models + Docker image (add --native for the exe)
node scripts/imagegen.js gen --preset icon --count 3 --seed 42 \
  --prompt "a laptop character, screen lit, eyes open, smiling" \
  --out docs/tasks/todo/<task>/images/laptop-working.png
node scripts/imagegen.js --help
```

- **Presets:** `icon` 1024×1024, `about` 1536×896, `banner` 1792×576, `square` 768×768 (default).
  `--width/--height` override; sizes round down to a multiple of 64.
- **Styles** (prefix added to the prompt, `--style`): `kawaii-serious` (default — "cute but
  serious": a calm, competent mascot, flat shading, dark outlines, pastel plus one accent),
  `kawaii` (chibi, big shiny eyes, sticker look), `none`. Add a style in `STYLES` in the script.
- **Variants:** `--count N` uses seeds `seed … seed+N-1`; files get `-1 … -N` suffixes. Keep the
  same `--seed` across prompts that should show the *same character* in different states — it
  keeps the shape and palette much closer than random seeds.
- Each PNG gets a sidecar `<name>.json` (prompt, style, seed, size, model, seconds) to reproduce
  it; `--no-meta` skips it.

## Prompt tips (FLUX.1-schnell)

- Describe the subject first, then pose/state, then background: "a single cute laptop character
  with a face on its screen, …, plain white background".
- FLUX follows long natural-language prompts well; negative prompts do nothing at `cfg 1`, so say
  what you want instead ("plain background", "no text").
- Ask for "no text" — schnell likes to invent captions.
- Facial expression, props and small symbols (Z's, sparkles, a tear) follow the prompt reliably;
  changes to the object's own geometry ("lid half-closed") are mostly ignored — show a state with
  the face and props instead.
- Generate 4 variants with `--count 4` and pick; one seed often gives a consistent family across
  all states (for the AgentBook laptop it was seed 44), so compare variants *by seed*.
- A 12 GB card renders a 1024×1024 image in about 15 s, model load included.
- Icons for small sizes (21–54 px in AgentBook): ask for "simple shapes, thick outlines, few
  details"; check the result scaled down, not at 1024 px.
- No transparency: generate on a plain light background and cut it out in an editor, or trace to SVG.

## What never goes into git

- Models, binaries and work files live in `$IMAGEGEN_HOME` (default `<repo>/tmp/imagegen`,
  gitignored). Set `IMAGEGEN_HOME` to keep the 14 GB elsewhere.
- sd.cpp writes the full command line (absolute model paths) into PNG text chunks; the script
  strips all `tEXt` / `zTXt` / `iTXt` chunks, and the sidecar JSON holds no paths. Only the
  pictures you choose to keep (and their JSON) are committed, e.g. into the task's `images/` folder.
- Nothing about the developer's machine (GPU model, local paths, timings on a given box) goes into
  tracked files.
