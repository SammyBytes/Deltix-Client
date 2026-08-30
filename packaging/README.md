# Packaging & distribution

How to install Deltix-Client **without third-party moderation** — just you and
GitHub Releases. (Docker is intentionally not the end-user path for a CLI.)

## Linux & macOS (incl. Arch) — curl installer

A single command downloads the right binary for your OS/arch, verifies its
SHA-256 against the digest GitHub publishes for the release asset, and installs
to `~/.local/bin` (no sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/SammyBytes/Deltix-Client/main/scripts/get-deltix-client.sh | bash
```

Pin a version, or install system-wide:

```bash
curl -fsSL .../get-deltix-client.sh | VERSION=0.7.0 bash
curl -fsSL .../get-deltix-client.sh | sudo bash -s -- --system   # -> /usr/local/bin
```

Requirements: `curl`, and `python3` (default on Arch/macOS) or `jq` to parse the
release manifest. Ensure `~/.local/bin` is on your `PATH`.

## Windows — Scoop (self-hosted bucket, no moderation)

Scoop installers point at **your own bucket repo** (a GitHub repo you control),
so there is no upstream review/waiting like `winget-pkgs`.

1. Create a repo `SammyBytes/deltix-bucket` with a `bucket/` folder.
2. Put [`scoop/deltix.json`](./scoop/deltix.json) at `bucket/deltix.json`.
3. Users install:

   ```powershell
   scoop bucket add deltix https://github.com/SammyBytes/deltix-bucket
   scoop install deltix
   ```

4. On each new release, bump `version` + `hash` in the manifest (or let
   `scoop checkup`/`autoupdate` refresh the URL; hashes must be updated via
   `scoop cat`/CI).

## Updating this repo's manifests on release

When you cut a new tag `vX.Y.Z`:
- `packaging/scoop/deltix.json`: set `version` and the Windows `hash` (the
  SHA-256 shown by `gh release view vX.Y.Z` / the asset `digest`).
- The curl installer needs no change — it resolves the latest release at runtime.

## Deferred (needs third-party moderation, not done here)

- **winget** (`SammyBytes.Deltix`): PR a manifest to `microsoft/winget-pkgs`.
- **AUR** (`deltix-client`): PKGBUILD to `aur.archlinux.org` — nice for Arch, but
  the curl installer already covers Arch with zero setup.
- **Homebrew tap** for macOS.
