{ lib, pkgs, config, ... }:

let
  cfg = config.services.cerbernix;
in {
  options.services.cerbernix = {
    enable = lib.mkEnableOption "cerbernix binary cache upload daemon";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The cerbernix package to use.";
    };

    cacheUrl = lib.mkOption {
      type = lib.types.str;
      description = "URL of the binary cache to upload to.";
      example = "https://cache.example.com";
    };

    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a file containing the bearer token for cache authentication.
        Read at runtime, not stored in the nix store.
        Compatible with sops-nix, agenix, or manual placement.
      '';
      example = "/run/secrets/cerbernix-token";
    };

    socket = lib.mkOption {
      type = lib.types.str;
      description = "Path to the unix socket for the cerbernix daemon.";
    };

    debounce = lib.mkOption {
      type = lib.types.int;
      default = 5;
      description = "Batch debounce time in seconds.";
    };

    maxUploads = lib.mkOption {
      type = lib.types.int;
      default = 8;
      description = "Maximum number of concurrent uploads.";
    };
  };

  config = lib.mkIf cfg.enable {
    nix.settings.post-build-hook = toString (pkgs.writeShellScript "cerbernix-post-build-hook" ''
      if [ -e "${cfg.socket}" ]; then
        exec ${lib.getExe cfg.package} hook --socket "${cfg.socket}"
      fi
    '');
  };
}
