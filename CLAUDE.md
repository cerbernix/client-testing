# Cerbernix Client Testing

Nix flake that distributes pre-built cerbernix binaries via NixOS and nix-darwin modules.

## Updating to a new release

1. Get the latest release tag and asset URLs:
   ```
   gh release view --repo cerbernix/client-testing --json tagName,assets
   ```

2. Update `version` and `sources` URLs in `flake.nix` with the new tag.

3. Prefetch hashes for each platform (do NOT use `--unpack` since `fetchurl` fetches without unpacking):
   ```
   nix-prefetch-url --type sha256 "<url>" 2>/dev/null | tail -1 | xargs nix hash convert --to sri --hash-algo sha256
   ```

4. Update the `hash` fields in `flake.nix`.

5. Build and verify:
   ```
   nix build .#cerbernix
   ./result/bin/cerbernix daemon --help
   ```
