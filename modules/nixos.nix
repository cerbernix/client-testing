{ self }:

{ lib, pkgs, config, ... }:

let
  cfg = config.services.cerbernix;

  daemonScript = pkgs.writeShellScript "cerbernix-daemon-start" (''
    ${lib.optionalString (cfg.tokenFile != null) ''
      export CERBERNIX_TOKEN="$(cat "${cfg.tokenFile}")"
    ''}
    exec ${lib.getExe cfg.package} daemon \
      --cache-url "${cfg.cacheUrl}" \
      --socket "${cfg.socket}" \
      --debounce "${toString cfg.debounce}" \
      --max-uploads "${toString cfg.maxUploads}"
  '');
in {
  imports = [ ./shared.nix ];

  options.services.cerbernix = {
    package = lib.mkOption {
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.cerbernix;
      defaultText = lib.literalExpression "self.packages.\${pkgs.stdenv.hostPlatform.system}.cerbernix";
    };

    socket = lib.mkOption {
      default = "/run/cerbernix/cerbernix.sock";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.cerbernix-daemon = {
      description = "Cerbernix binary cache upload daemon";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      serviceConfig = {
        ExecStart = daemonScript;
        Restart = "on-failure";
        RestartSec = 5;
        RuntimeDirectory = "cerbernix";

        # Security hardening
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ "/nix/store" ];
      };
    };
  };
}
