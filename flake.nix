{
  description = "Stem: cut your own pipes, hear the air column decide the pitch";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # Goldens are painted and compared inside one browser process, so each
      # system needs the same browser build for a baseline to mean the same
      # pixels. Only x86_64-linux is exercised by CI.
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.playwright-driver
            pkgs.git
            pkgs.python3
          ];

          env = {
            # ESM ignores NODE_PATH, so the driver is addressed by absolute
            # path. The entry is index.mjs at the top level of the driver
            # package, not package/index.mjs.
            PLAYWRIGHT_ENTRY = "${pkgs.playwright-driver}/index.mjs";
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          };

          shellHook = ''
            echo "Stem: ./check.sh   (build, syntax, acoustics, browser, goldens)"
          '';
        };
      });

      packages = forAllSystems (pkgs: {
        # The artifact alone. `nix build` producing something other than
        # exactly index.html would mean the bundler had started emitting
        # siblings, which breaks the single-file promise.
        default =
          pkgs.runCommand "stem"
            {
              src = ./.;
              nativeBuildInputs = [ pkgs.nodejs_22 ];
            }
            ''
              # Build into $out, not beside the sources: a Nix source tree is a
              # read-only store path, so writing the artifact next to src/ fails
              # with EACCES. tools/build.mjs takes the output path for this.
              node "$src/tools/build.mjs" "$out/index.html"
              test -s "$out/index.html"
              # The artifact must be self-contained: no external asset references.
              # Only bare in-page fragments (#) and inline data: URIs are allowed.
              ! grep -qE '<(script|link|img|source|iframe)[^>]+(src|href)="[^#d]' "$out/index.html" \
                || { echo "artifact references an external file"; exit 1; }
            '';
      });
    };
}
