{
  description = "NixOS and nix-darwin modules for cerbernix binary cache upload service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }: let
    version = "0.1.0+b1f09e1";

    sources = {
      x86_64-linux = {
        url = "https://github.com/cerbernix/client-testing/releases/download/v0.1.0%2Bb1f09e1/cerbernix-x86_64-unknown-linux-gnu.tar.gz";
        hash = "sha256-28RPYriZekUhfdDFQWWXXZzv2lmIWUXIW132wo2yjOg=";
      };
      aarch64-darwin = {
        url = "https://github.com/cerbernix/client-testing/releases/download/v0.1.0%2Bb1f09e1/cerbernix-aarch64-apple-darwin.tar.gz";
        hash = "sha256-Yyn1HLwuAGQfylf1OmmEcoEFFZ0Vr46VROZTBaEHVbA=";
      };
    };

    mkPackage = system: let
      pkgs = nixpkgs.legacyPackages.${system};
      src = sources.${system} or (throw "cerbernix: unsupported system ${system}");
    in pkgs.stdenv.mkDerivation {
      pname = "cerbernix";
      inherit version;

      src = pkgs.fetchurl {
        inherit (src) url hash;
      };

      sourceRoot = ".";

      dontConfigure = true;
      dontBuild = true;

      installPhase = ''
        install -Dm755 cerbernix $out/bin/cerbernix
      '';

      meta = {
        description = "Cerbernix binary cache upload client";
        mainProgram = "cerbernix";
        platforms = builtins.attrNames sources;
      };
    };

    supportedSystems = builtins.attrNames sources;

  in {
    packages = builtins.listToAttrs (map (system: {
      name = system;
      value = {
        cerbernix = mkPackage system;
        default = mkPackage system;
      };
    }) supportedSystems);

    nixosModules.cerbernix = import ./modules/nixos.nix { inherit self; };
    nixosModules.default = self.nixosModules.cerbernix;

    darwinModules.cerbernix = import ./modules/darwin.nix { inherit self; };
    darwinModules.default = self.darwinModules.cerbernix;
  };
}
