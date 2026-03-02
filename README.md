# cerbernix

Nix modules for automatically uploading build outputs to a [Cerbernix](https://cerbernix.com) binary cache.

Provides NixOS and nix-darwin modules that run a `cerbernix daemon` and configure a `post-build-hook` so every `nix build` automatically pushes to your cache.

## Usage

### NixOS

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    cerbernix.url = "github:cerbernix/client-testing";
  };

  outputs = { nixpkgs, cerbernix, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        cerbernix.nixosModules.cerbernix
        {
          services.cerbernix = {
            enable = true;
            cacheUrl = "https://your-team.cerbernix.com";
            tokenFile = "/run/secrets/cerbernix-token"; # https://github.com/bitnixdev/arcanum, sops-nix, agenix, etc.
          };
        }
      ];
    };
  };
}
```

### nix-darwin

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    darwin.url = "github:LnL7/nix-darwin";
    cerbernix.url = "github:cerbernix/client-testing";
  };

  outputs = { nixpkgs, darwin, cerbernix, ... }: {
    darwinConfigurations.myhost = darwin.lib.darwinSystem {
      system = "aarch64-darwin";
      modules = [
        cerbernix.darwinModules.cerbernix
        {
          services.cerbernix = {
            enable = true;
            cacheUrl = "https://your-team.cerbernix.com";
            tokenFile = "/run/secrets/cerbernix-token"; # https://github.com/bitnixdev/arcanum, sops-nix, agenix, etc.
          };
        }
      ];
    };
  };
}
```

## Options

| Option       | Type         | Default            | Description                                        |
| ------------ | ------------ | ------------------ | -------------------------------------------------- |
| `enable`     | bool         | `false`            | Enable the daemon and post-build-hook              |
| `package`    | package      | from this flake    | The cerbernix package                              |
| `cacheUrl`   | string       | —                  | Cache URL (e.g. `https://your-team.cerbernix.com`) |
| `tokenFile`  | path or null | `null`             | File containing bearer token (read at runtime)     |
| `netrcFile`  | path or null | `null`             | Path to a netrc file for credential lookup         |
| `socket`     | string       | platform-dependent | Unix socket path                                   |
| `debounce`   | int          | `5`                | Batch debounce seconds                             |
| `maxUploads` | int          | `8`                | Max concurrent uploads                             |
| `logFile`    | path or null | `null`             | Path to a file for daemon log output               |

The socket defaults to `/run/cerbernix/cerbernix.sock` on NixOS and `/var/run/cerbernix/cerbernix.sock` on darwin.

## Secrets

There are two ways to provide credentials:

- **`tokenFile`** — Points to a file containing your `cbx_...` bearer token. It is read at service start into the `CERBERNIX_TOKEN` environment variable — never passed as a CLI argument or stored in the nix store.
- **`netrcFile`** — Points to a [netrc](https://www.gnu.org/software/inetutils/manual/html_node/The-_002enetrc-file.html) file. The daemon looks up credentials by matching the cache host. This is useful if you already manage credentials via netrc.

Both are compatible with [arcanum](https://github.com/bitnixdev/arcanum), [sops-nix](https://github.com/Mic92/sops-nix), [agenix](https://github.com/ryantm/agenix), or manual file placement.

## Verifying

**NixOS:**

```sh
nixos-rebuild switch
systemctl status cerbernix-daemon
```

**nix-darwin:**

```sh
darwin-rebuild switch
launchctl list | grep cerbernix
```

Any `nix build` should now trigger the post-build-hook and upload outputs to your cache.
