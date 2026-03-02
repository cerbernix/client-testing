{ self }:

{ lib, pkgs, config, ... }:

let
  cfg = config.services.cerbernix;

  daemonScript = pkgs.writeShellScript "cerbernix-daemon-start" ''
    /bin/wait4path /nix/store

    mkdir -p "$(dirname "${cfg.socket}")"

    ${lib.optionalString (cfg.tokenFile != null) ''
      export CERBERNIX_TOKEN="$(cat "${cfg.tokenFile}")"
    ''}

    exec ${lib.getExe cfg.package} daemon \
      --cache-url "${cfg.cacheUrl}" \
      --socket "${cfg.socket}" \
      --debounce "${toString cfg.debounce}" \
      --max-uploads "${toString cfg.maxUploads}" \
      ${lib.optionalString (cfg.netrcFile != null) ''--netrc-file "${cfg.netrcFile}"''}
  '';
in {
  imports = [ ./shared.nix ];

  options.services.cerbernix = {
    package = lib.mkOption {
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.cerbernix;
      defaultText = lib.literalExpression "self.packages.\${pkgs.stdenv.hostPlatform.system}.cerbernix";
    };

    socket = lib.mkOption {
      default = "/var/run/cerbernix/cerbernix.sock";
    };
  };

  config = lib.mkIf cfg.enable {
    launchd.daemons.cerbernix-daemon = {
      serviceConfig = {
        Label = "com.cerbernix.daemon";
        ProgramArguments = [ "/bin/sh" "-c" "${daemonScript}" ];
        KeepAlive = true;
        RunAtLoad = true;
        StandardOutPath = if cfg.logFile != null then cfg.logFile else "/var/log/cerbernix/daemon.log";
        StandardErrorPath = if cfg.logFile != null then cfg.logFile else "/var/log/cerbernix/daemon.err.log";
      };
    };
  };
}
